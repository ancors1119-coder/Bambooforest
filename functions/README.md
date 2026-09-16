# 게시판 삭제 함수 배포

게시판은 작성자 정보를 저장하지 않는다. 글마다 다른 `nonce` 와, 그것을 작성자
uid 와 함께 해시한 `authorTag` 만 남는다. 덕분에 같은 사람이 쓴 글끼리 묶이지
않지만, Firestore 보안 규칙에는 해시 함수가 없어 규칙만으로는 "이 요청자가
작성자인가" 를 판정할 수 없다.

그래서 삭제만 이 함수를 거친다. 함수는 호출자 uid 로 `authorTag` 를 다시
계산해 문서의 값과 맞춰본다. uid 는 어디에도 저장하지 않으므로 익명성은 그대로다.

- 구성원: 본인이 쓴 글·댓글만 삭제
- 관리자(`admins/{uid}` 문서 보유): 전부 삭제
- 규칙: `allow delete: if isAdmin();` — 함수는 Admin SDK 라 규칙을 우회한다

## 배포 전 준비

1. **Blaze 요금제로 전환**
   Firebase 콘솔 → 왼쪽 아래 요금제 → Blaze.
   Cloud Functions 는 Blaze 에서만 쓸 수 있다. 종량제지만 무료 한도(월 200만 호출)가
   있어 300명 규모에서는 실제 청구가 발생하지 않는다.
   걱정되면 콘솔에서 **예산 알림**을 걸어두면 된다.

2. **Node.js 20 이상**과 **Firebase CLI**
   ```
   npm install -g firebase-tools
   firebase login
   ```

## 배포

저장소 루트에서 (.firebaserc 가 있어 --project 는 필요 없다):

```
cd functions && npm install && cd ..
firebase deploy --only functions
```

배포 뒤 한 번은 정리 정책을 걸어둔다. 배포할 때마다 컨테이너 이미지가
Artifact Registry 에 쌓여 매달 조금씩 과금되는 것을 막아준다.

```
firebase functions:artifacts:setpolicy --location asia-northeast3
```

리전을 빼면 기본값 us-central1 에서 저장소를 찾다가 실패한다. 기본 정책은
하루 지난 이미지를 지우는 것인데, 배포된 함수는 이미 Cloud Run 에 올라가
있으므로 안전하다.

처음 배포할 때는 필요한 API(Cloud Functions, Cloud Build, Artifact Registry)를
켜도 되는지 물어본다. 모두 예로 답하면 된다. 5~10분쯤 걸린다.

규칙과 색인도 CLI 로 함께 올릴 수 있다:

```
firebase deploy --only firestore:rules,firestore:indexes
```

## 배포 후 확인

1. 게시판에 글을 쓰고 **본인 글 삭제** → 지워지면 정상
2. 브라우저 콘솔(F12)에서 남의 글 삭제를 시도 → `permission-denied` 가 나오면 정상
3. 관리자로 로그인해 아무 글이나 삭제 → 지워지면 정상

## 런타임

Node 22 를 쓴다. Node 20 은 2026-10-30 에 폐기되어 그 뒤로는 배포 자체가
막히므로, 그 전에 올려두었다.

## 주의

- `BOARD_SALT` 와 `APP_ID` 는 `index.html` 의 값과 **반드시 같아야** 한다.
  어긋나면 "본인 글인데 삭제가 거부되는" 형태로만 드러나 원인을 찾기 어렵다.
- 리전은 `asia-northeast3`(서울) 로 맞춰져 있다. `index.html` 의
  `getFunctions(app, 'asia-northeast3')` 와 같은 값이어야 한다.
