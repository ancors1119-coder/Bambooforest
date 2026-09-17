/**
 * 대나무숲 게시판 삭제 함수
 *
 * 게시판은 작성자 정보를 저장하지 않는다. 글에는 글마다 다른 nonce 와,
 * 그 nonce 로 소금 친 4자리 비밀번호의 해시만 남는다. 해시는 글 문서가 아니라
 * board_secrets 컬렉션에 따로 두고, 규칙에서 읽기를 전면으로 막아 두었다.
 *
 * 왜 따로 두는가. 4자리는 경우의 수가 1만 개뿐이라, 해시를 손에 넣으면
 * 되맞추는 데 1초도 걸리지 않는다. 게시판 글 자체는 로그인 없이도 읽히므로,
 * 해시를 글 문서에 같이 넣었다면 누구나 남의 글을 지울 수 있었다.
 *
 * 해시를 못 읽으면 남은 방법은 함수에 하나씩 찍어보는 것뿐인데, 그 시도를
 * 여기서 센다. MAX_TRIES 번 틀리면 LOCK_MINUTES 분 잠긴다. 1만 개를 다 해보려면
 * 글 하나당 2주가 넘게 걸리므로 사실상 불가능하다.
 *
 * 관리자는 비밀번호 없이도 지울 수 있다(신고 누적 글 정리 등). 다만 관리자도
 * 해시를 '읽지는' 못한다. 계정 하나가 새도 전체가 털리지 않게 하기 위해서다.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

// index.html 의 BOARD_SALT / makePinHash 와 반드시 같은 값·같은 방식이어야 한다.
const BOARD_SALT = "bambooforest-board-v1";
const APP_ID = "hr_dashboard";   // index.html 의 APP_ID 와 같아야 한다

const MAX_TRIES = 5;             // 이만큼 틀리면
const LOCK_MINUTES = 10;         // 이만큼 잠근다

const pinHash = (nonce, pin) =>
  crypto.createHash("sha256").update(`${BOARD_SALT}:${nonce}:${pin}`).digest("hex");

const dataCol = (name) => db.collection(`artifacts/${APP_ID}/public/data/${name}`);
const isAdmin = async (uid) => (await db.collection("admins").doc(uid).get()).exists;

/** 숫자 네 자리만 통과시킨다. 형식이 아니면 시도로 세지도 않는다. */
const cleanPin = (v) => {
  const p = String(v == null ? "" : v).trim();
  return /^[0-9]{4}$/.test(p) ? p : "";
};

/**
 * 비밀번호를 대조한다. 맞으면 비밀번호 문서를 지울 수 있게 ref 를 돌려준다.
 * 관리자면 대조 없이 통과한다.
 */
const verify = async ({ secretId, nonce, pin, uid, what }) => {
  if (await isAdmin(uid)) {
    return { ok: true, admin: true, secretRef: secretId ? dataCol("board_secrets").doc(secretId) : null };
  }

  if (!secretId) {
    // 비밀번호를 받기 전에 쓴 글. 본인 확인 수단이 없으므로 관리자만 지운다.
    throw new HttpsError("failed-precondition",
      `비밀번호가 없는 ${what}입니다. 관리자에게 삭제를 요청해주세요.`);
  }

  const clean = cleanPin(pin);
  if (!clean) throw new HttpsError("invalid-argument", "비밀번호는 숫자 4자리입니다.");

  const secretRef = dataCol("board_secrets").doc(secretId);
  const snap = await secretRef.get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition",
      `비밀번호를 찾을 수 없습니다. 관리자에게 삭제를 요청해주세요.`);
  }

  const secret = snap.data();
  const now = Date.now();
  const lockedUntil = Number(secret.lockedUntil) || 0;
  if (lockedUntil > now) {
    const left = Math.ceil((lockedUntil - now) / 60000);
    throw new HttpsError("resource-exhausted",
      `비밀번호를 여러 번 틀렸습니다. ${left}분 뒤에 다시 시도해주세요.`);
  }

  // 잠금이 풀린 뒤 첫 시도면 횟수를 0부터 다시 센다.
  const tries = lockedUntil > 0 ? 0 : (Number(secret.tries) || 0);

  if (pinHash(nonce, clean) !== secret.hash) {
    const next = tries + 1;
    await secretRef.update(next >= MAX_TRIES
      ? { tries: 0, lockedUntil: now + LOCK_MINUTES * 60000 }
      : { tries: next, lockedUntil: 0 });
    const left = MAX_TRIES - next;
    throw new HttpsError("permission-denied", left > 0
      ? `비밀번호가 맞지 않습니다. ${left}번 더 틀리면 ${LOCK_MINUTES}분 동안 잠깁니다.`
      : `비밀번호가 맞지 않습니다. ${LOCK_MINUTES}분 동안 잠깁니다.`);
  }

  if (tries || lockedUntil) await secretRef.update({ tries: 0, lockedUntil: 0 });
  return { ok: true, admin: false, secretRef };
};

/** 글 삭제. 비밀번호를 아는 사람 또는 관리자만. 글에 달린 댓글도 같이 지운다. */
exports.deleteBoardPost = onCall({ region: "asia-northeast3" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const postId = String((req.data && req.data.postId) || "").trim();
  if (!postId) throw new HttpsError("invalid-argument", "postId 가 없습니다.");

  const ref = dataCol("board_posts").doc(postId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "이미 삭제된 글입니다.");

  const post = snap.data();
  const { secretRef } = await verify({
    secretId: post.secretId, nonce: post.nonce,
    pin: req.data && req.data.pin, uid, what: "글"
  });

  // 댓글과 그 비밀번호 문서까지 함께 지운다. 많아도 한 번에 지울 수 있게 나눈다.
  const comments = await dataCol("board_comments").where("postId", "==", postId).get();
  let batch = db.batch();
  let n = 0;
  const step = async () => { if (++n % 300 === 0) { await batch.commit(); batch = db.batch(); } };
  for (const c of comments.docs) {
    const sid = c.data().secretId;
    if (sid) { batch.delete(dataCol("board_secrets").doc(sid)); await step(); }
    batch.delete(c.ref); await step();
  }
  if (secretRef) { batch.delete(secretRef); await step(); }
  batch.delete(ref);
  await batch.commit();

  return { ok: true, deletedComments: comments.size };
});

/** 댓글 삭제. 비밀번호를 아는 사람 또는 관리자만. */
exports.deleteBoardComment = onCall({ region: "asia-northeast3" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const commentId = String((req.data && req.data.commentId) || "").trim();
  if (!commentId) throw new HttpsError("invalid-argument", "commentId 가 없습니다.");

  const ref = dataCol("board_comments").doc(commentId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "이미 삭제된 댓글입니다.");

  const comment = snap.data();
  // 댓글의 소금도 '그 글의 nonce' 이므로 원글을 읽어야 대조할 수 있다.
  const postSnap = await dataCol("board_posts").doc(String(comment.postId)).get();
  const nonce = postSnap.exists ? postSnap.data().nonce : null;

  const { secretRef } = await verify({
    secretId: comment.secretId, nonce,
    pin: req.data && req.data.pin, uid, what: "댓글"
  });

  const batch = db.batch();
  if (secretRef) batch.delete(secretRef);
  batch.delete(ref);
  await batch.commit();

  if (postSnap.exists) {
    await postSnap.ref.update({ commentCount: FieldValue.increment(-1) });
  }
  return { ok: true };
});
