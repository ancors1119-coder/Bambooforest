/**
 * 대나무숲 게시판 삭제 함수
 *
 * 게시판은 작성자 정보를 저장하지 않는다. 글에는 글마다 다른 nonce 와,
 * 그 nonce 와 작성자의 비밀을 함께 해시한 authorTag 만 남는다.
 * 이 구조 덕분에 같은 사람이 쓴 글끼리 묶이지 않지만, 대신 Firestore
 * 보안 규칙만으로는 '이 요청자가 작성자인가' 를 판정할 수 없다.
 * 규칙에는 해시 함수가 없기 때문이다.
 *
 * 그래서 삭제만 이 함수를 거친다. 함수가 authorTag 를 다시 계산해 문서에
 * 저장된 값과 맞춰본다. 맞으면 작성자다. 비밀은 어디에도 저장하지 않는다.
 *
 * 비밀은 둘 중 하나다.
 *   key … 브라우저가 만든 익명 열쇠. 다른 기기로 옮길 수 있어 어디서든
 *         자기 글을 지울 수 있다. 열쇠를 안다는 것 자체가 증명이며,
 *         남의 글을 지우려면 sha256 역산이 필요하므로 위조할 수 없다.
 *   uid … 열쇠 방식 이전에 쓰던 값. 그때 쓴 글을 계속 지울 수 있도록
 *         함께 인정한다. 옛 글이 다 사라지면 이 경로는 지워도 된다.
 *
 * 규칙 쪽은 board_posts / board_comments 의 delete 를 관리자에게만 열어두면 된다.
 * 이 함수는 Admin SDK 로 동작해 규칙을 우회한다.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

// index.html 의 BOARD_SALT / makeAnonTag 와 반드시 같은 값·같은 방식이어야 한다.
const BOARD_SALT = "bambooforest-board-v1";
const APP_ID = "hr_dashboard";   // index.html 의 APP_ID 와 같아야 한다

const anonTag = (nonce, secret) =>
  crypto.createHash("sha256").update(`${BOARD_SALT}:${nonce}:${secret}`).digest("hex").slice(0, 16);

// 열쇠는 16바이트 난수를 소문자 16진수로 적은 32자다. 형식이 아니면 아예 보지 않는다.
const cleanKey = (v) => {
  const k = String(v || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return k.length === 32 ? k : "";
};

/** 이 nonce/authorTag 의 주인이 맞는가. 열쇠로 맞거나, 예전 uid 로 맞으면 주인이다. */
const ownsTag = (nonce, authorTag, key, uid) => {
  if (!nonce || !authorTag) return false;
  if (key && anonTag(nonce, key) === authorTag) return true;
  return !!uid && anonTag(nonce, uid) === authorTag;
};

const dataCol = (name) => db.collection(`artifacts/${APP_ID}/public/data/${name}`);

const isAdmin = async (uid) => (await db.collection("admins").doc(uid).get()).exists;

/** 글 삭제. 작성자 본인 또는 관리자만. 글에 달린 댓글도 같이 지운다. */
exports.deleteBoardPost = onCall({ region: "asia-northeast3" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const postId = String((req.data && req.data.postId) || "").trim();
  if (!postId) throw new HttpsError("invalid-argument", "postId 가 없습니다.");

  const ref = dataCol("board_posts").doc(postId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "이미 삭제된 글입니다.");

  const post = snap.data();
  const mine = ownsTag(post.nonce, post.authorTag, cleanKey(req.data && req.data.key), uid);
  if (!mine && !(await isAdmin(uid))) {
    throw new HttpsError("permission-denied", "본인이 쓴 글만 삭제할 수 있습니다.");
  }

  // 댓글이 많아도 한 번에 지울 수 있게 배치로 나눈다.
  const comments = await dataCol("board_comments").where("postId", "==", postId).get();
  let batch = db.batch();
  let n = 0;
  for (const c of comments.docs) {
    batch.delete(c.ref);
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  batch.delete(ref);
  await batch.commit();

  return { ok: true, deletedComments: comments.size };
});

/** 댓글 삭제. 댓글 작성자 본인 또는 관리자만. */
exports.deleteBoardComment = onCall({ region: "asia-northeast3" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const commentId = String((req.data && req.data.commentId) || "").trim();
  if (!commentId) throw new HttpsError("invalid-argument", "commentId 가 없습니다.");

  const ref = dataCol("board_comments").doc(commentId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "이미 삭제된 댓글입니다.");

  const comment = snap.data();
  // 댓글의 태그도 '그 글의 nonce' 로 만들어졌으므로 원글을 읽어야 검증할 수 있다.
  const postSnap = await dataCol("board_posts").doc(String(comment.postId)).get();
  const nonce = postSnap.exists ? postSnap.data().nonce : null;
  const mine = ownsTag(nonce, comment.authorTag, cleanKey(req.data && req.data.key), uid);
  if (!mine && !(await isAdmin(uid))) {
    throw new HttpsError("permission-denied", "본인이 쓴 댓글만 삭제할 수 있습니다.");
  }

  await ref.delete();
  if (postSnap.exists) {
    await postSnap.ref.update({ commentCount: FieldValue.increment(-1) });
  }
  return { ok: true };
});
