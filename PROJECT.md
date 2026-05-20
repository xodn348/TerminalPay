# AgentWallet — PROJECT.md

> **단일 진실 소스 (Single Source of Truth).**
> 이 파일에 적힌 것만이 합의된 범위입니다. 모든 결정/구현은 이 문서를 따라가며, 변경이 필요하면 **먼저 이 파일을 수정**하고 그다음에 코드가 따라옵니다.
> 코드와 이 문서가 어긋나면 **이 문서가 맞고 코드가 틀린 것입니다.**

소유자: Junhyuk Lee (이준혁) · Ebsilon, Inc.
시작: 2026-05-20
상태: pre-MVP — spec lock 단계

---

## 1. 목적 (Why)

AI 에이전트는 점점 더 많은 실제 업무를 사용자 대신 수행한다. 그러나 결제가 막혀 있는 한 에이전트의 자율성은 절반에 그친다.

- 사용자가 자기 신용카드를 에이전트에게 그대로 넘기는 것은 위험하다 (한 번 풀면 통제 불가).
- 가상카드를 발급하는 모델은 사용자 입장에서 등록이 무겁고 유연성도 떨어진다.
- 기존 결제 인프라(Stripe, PayPal 등)는 모두 **셀러 측** — 가맹점이 사용자에게 돈을 받게 해주는 도구다.

AgentWallet은 그 반대편을 만든다: **에이전트(바이어 측)가 사용자 위임 범위 안에서 자율적으로 결제할 수 있게 해주는 인프라.**

비유: Stripe가 가맹점에게 결제 인프라라면, AgentWallet은 에이전트에게 결제 인프라다.
사용자 UX 비유: MetaMask가 dApp에게 서명 권한을 주듯, AgentWallet은 AI 에이전트에게 결제 권한을 준다 — 단, 키 대신 OAuth 스코프, 크립토 대신 fiat USD.

---

## 2. 페르소나

### P1. 사용자 (Human Principal)
- 자기 AI 에이전트(Claude, Cursor, Cline, 자작 에이전트 등)에게 결제 권한을 위임하고 싶은 개인 개발자/AI 빌더/얼리어답터.
- 카드 자체를 에이전트에 주는 것은 무섭지만, **한도와 룰을 걸 수 있다면** 풀어두고 싶음.
- MetaMask 같은 명확한 통제 UI를 기대함.

### P2. AI 에이전트 (Delegated Actor)
- 사용자 위임을 받아 자율적으로 머천트에 결제하는 주체.
- API 키 충전, SaaS 구독 추가, 도메인 구입, 호스팅 비용 결제 등 작은 결제부터.
- 자기 행동을 사용자에게 영수증 + 이유로 보고할 책임이 있음.

### P3. 머천트 (Recipient)
- 결제를 받는 일반 가맹점. 우리 존재를 몰라도 됨 (그냥 카드 결제로 보임).
- 예: OpenAI, Anthropic, Vercel, Resend, GitHub, Cloudflare, Stripe 청구 등.

---

## 3. 핵심 유저 스토리

### 카드/계정 등록

**US-1.** P1로서, **내 신용카드를 한 번만** 등록하고 싶다. 그래야 이후 에이전트들에 일일이 카드를 다시 알려주지 않아도 된다.
- 카드 정보는 우리 서버에 저장되지 않아야 한다 (PCI-격리 vault만 통과).
- off-session 결제 동의(mandate)를 등록 시점에 명시적으로 받는다.

**US-2.** P1로서, 등록한 카드 외에도 **여러 결제수단**(여러 카드, 추후 ACH)을 추가하고 싶다. 그래야 에이전트별로 다른 결제수단을 쓸 수 있다.

### 에이전트 연결 (Authorize)

**US-3.** P1로서, **새 에이전트에 권한을 위임**할 때 OAuth 동의 화면 같은 명확한 UX로 다음을 한 번에 설정하고 싶다:
- 월간 한도 (예: $200)
- per-transaction 한도 (예: $50)
- HITL 임계값 (예: $20 이상은 사용자 승인 필요)
- 허용 머천트 도메인 화이트리스트 (예: openai.com, anthropic.com, vercel.com)
- 차단 카테고리 (예: gambling, adult)
- 유효시간 (예: 30일 후 자동 만료)
- 활성 시간대 (예: 09:00-23:00 Asia/Seoul)

**US-4.** P2로서, 사용자가 발급한 **OAuth 토큰**을 받아 우리 결제 API에 인증하고 싶다. 토큰은 짧은 만료(예: 15분)를 가지며 refresh로 갱신된다.

### 결제 (Pay)

**US-5.** P2로서, `wallet.pay({amount, merchant, description, context})` 한 줄로 결제를 요청하고, **HITL 임계값 미만이면 즉시 성공/실패 응답**을 받고 싶다. 그래야 워크플로우가 끊기지 않는다.

**US-6.** P2로서, 모든 결제 요청에 **`context.reason`**(왜 결제하는지)과 **`context.evidence`**(스크린샷/URL/태스크 ID)를 첨부해야 한다. 이 정보는 영수증에 영구 기록된다.

**US-7.** P2로서, **idempotency_key**로 중복 결제를 방지하고 싶다. 같은 키로 두 번 호출하면 두 번째는 첫 번째 결과를 그대로 받는다.

### HITL 승인 (Approve)

**US-8.** P1로서, HITL 임계값을 초과한 결제는 **푸시 알림과 익스텐션 팝업**으로 받고, 1탭으로 승인/거절하고 싶다.

**US-9.** P1로서, 출장/취침 등으로 승인이 늦어질 때를 위해 **요청 만료 시간**(기본 5분)을 설정할 수 있다. 만료된 요청은 자동 거절된다.

### 영수증/감사 (Audit)

**US-10.** P1로서, 모든 결제 내역을 **에이전트별/머천트별/카테고리별로 필터링**해서 보고 싶다. 각 영수증에는 에이전트가 남긴 "왜" 이유와 컨텍스트가 펼쳐 보인다.

**US-11.** P1로서, 의심스러운 결제는 영수증에서 **1탭으로 이의제기**하고 싶다. 우리는 그 정보로 PSP의 dispute 흐름을 자동 시작한다.

### 통제 (Control)

**US-12.** P1로서, **에이전트를 즉시 차단(kill switch)** 할 수 있어야 한다. 차단 시 해당 에이전트의 모든 미래 결제가 거절된다.

**US-13.** P1로서, 에이전트의 한도를 **실시간으로 수정**할 수 있어야 한다. 다음 결제부터 즉시 새 한도가 적용된다.

**US-14.** P1로서, 에이전트의 **사용량 대시보드**(이번 달 누적, 남은 한도, 최근 결제, 트렌드)를 한눈에 보고 싶다.

### 개발자 경험 (DX)

**US-15.** P2로서, TypeScript와 Python SDK로 5분 안에 통합할 수 있어야 한다.

**US-16.** P2로서, **MCP 서버**가 제공되어 Claude Desktop·Cursor·Cline에서 별도 SDK 없이 바로 결제 툴을 호출할 수 있어야 한다.

---

## 4. 비목적 (Non-goals) — 명시적으로 안 하는 것

다음 항목들은 **MVP 단계에서 의도적으로 제외**한다. 유혹이 와도 PROJECT.md 수정 없이는 추가하지 않는다.

- ❌ **가상카드 발급 (Card Issuing)** — Stripe Issuing 등으로 우리가 카드를 발급하지 않는다. 사용자 본인 카드를 위임받는 모델만.
- ❌ **크립토/스테이블코인 결제** — x402, USDC, on-chain 일체 없음. fiat USD only.
- ❌ **사용자 자금 보관 (Custody)** — 우리 계좌에 사용자 돈을 받지 않는다. 결제는 사용자 카드에서 머천트로 직접. 우리는 정책 게이트일 뿐.
- ❌ **ACH/은행 직결** — MVP에서는 카드만. ACH/RTP는 v2 이후 고려.
- ❌ **B2B 엔터프라이즈 (다중 사용자 조직/ERP 연동)** — MVP는 1인 사용자 + 다중 에이전트. 조직·역할·SOC2는 v2 이후.
- ❌ **머천트(셀러) 측 도구** — 우리는 buyer-side만. 머천트가 "x402처럼 우리한테 결제받게" 해주지 않는다.
- ❌ **신용 제공 / BNPL** — 사용자 카드 한도 안에서만 작동. 우리가 신용을 주지 않는다.
- ❌ **로열티/리워드/캐시백** — 결제 흐름과 무관한 부가기능 전부 v2 이후.

---

## 5. 스코프 (MVP 1차)

### 통화 / 결제수단
- USD only.
- 신용/체크카드만 (Visa, Mastercard, Amex, Discover).
- off-session merchant-initiated transactions (MIT).

### 지역
- 사용자: 미국 카드를 가진 누구나 (실거주는 무관).
- 머천트: PSP가 지원하는 글로벌 머천트 어디든.
- 결제 통화: USD 단일.

### 플랫폼
- 웹 대시보드 (PWA-급): 카드 관리, 에이전트 관리, 결제 내역.
- **크롬 익스텐션** (Manifest V3): 결제 승인 팝업, 잔액/한도 위젯, 빠른 차단.
- API: REST + JSON, OAuth 2.1 + Bearer 토큰.
- SDK: TypeScript, Python.
- MCP 서버: stdio + HTTP 두 transport.

### 알림
- Web Push (브라우저).
- 이메일 (Resend).
- (v2) SMS via Twilio.

---

## 6. 아키텍처 원칙 (Inviolables)

다음 원칙들은 PROJECT.md 수정 없이는 깨지 않는다.

### A1. 카드 PAN/CVV는 우리 인프라에 절대 들어오지 않는다
- vault는 외부 PCI-격리 서비스(Basis Theory 등)를 통과한다.
- 우리는 vault 토큰만 저장한다. PCI 범위는 SAQ-A 수준으로 유지.

### A2. 사용자가 항상 last word를 가진다
- 어떤 정책이든 사용자가 즉시 수정·취소할 수 있다.
- kill switch는 1탭/1초 안에 작동해야 한다.
- HITL 임계값을 0으로 설정하면 모든 결제가 승인 대기로 간다.

### A3. PSP-agnostic (벤더 락인 회피)
- PSP(Stripe, Braintree 등)는 교체 가능한 부품으로 다룬다.
- vault 토큰은 어떤 PSP에든 라우팅 가능해야 한다.
- 한 PSP가 거절/제한되어도 다른 PSP로 즉시 swap 가능한 구조.

### A4. 모든 결제에 "왜"가 기록된다
- 에이전트는 `context.reason`을 첨부하지 않으면 결제 요청이 거절된다.
- 영수증은 "왜+무엇+얼마"를 항상 함께 보관한다.
- 이 데이터는 사용자 신뢰의 토대이자 우리 차별화 포인트.

### A5. 정책 평가는 결정론적이고 감사 가능하다
- 모든 정책 결정은 입력 → 평가 → 결과를 append-only 로그에 남긴다.
- 같은 입력은 항상 같은 결과를 낸다.
- 사용자는 "왜 이 결제가 거절됐는지/승인됐는지"를 언제든 추적할 수 있다.

### A6. 토큰은 짧고 좁다
- 에이전트 OAuth 토큰의 기본 만료는 15분.
- 스코프는 항상 최소 권한 원칙. "모든 머천트"는 절대 디폴트가 아니다.

### A7. PROJECT.md가 진실, 코드가 따라온다
- 범위 변경 → PROJECT.md 먼저 → 그다음 코드.
- 코드에 PROJECT.md가 모르는 기능이 있으면 그 기능은 제거 대상이다.

---

## 7. 기술 스택 (현재 가설 — 잠금 전)

| 레이어 | 1순위 | 백업 | 잠금 상태 |
|---|---|---|---|
| 카드 Vault | Basis Theory | VGS, Skyflow | 🟡 잠금 전 |
| PSP (1차) | Stripe (Standard) | Braintree (PayPal), Checkout.com | 🟡 Stripe 계정 상태 확인 필요 |
| 백엔드 언어 | TypeScript (Node.js + Hono) | Python (FastAPI) | 🟡 잠금 전 |
| DB | Postgres (Neon) | — | 🟢 |
| 인증/계정 | Clerk + Passkey/WebAuthn | Auth.js 자체 | 🟡 |
| 정책 엔진 | OPA (Open Policy Agent) | Cedar (AWS), 자체 DSL | 🟡 |
| 호스팅 | Vercel (API) + Cloudflare Workers (edge policy) | Railway, Fly.io | 🟡 |
| 익스텐션 | Chrome Manifest V3 (Plasmo 또는 WXT) | — | 🟢 |
| SDK 1차 | TypeScript | Python | 🟢 |
| MCP 서버 | TypeScript (stdio + HTTP) | — | 🟢 |
| 알림 | Web Push + Resend(email) | Twilio (v2) | 🟢 |

---

## 8. 잠금되지 않은 결정사항 (Open Decisions)

다음 결정들은 아직 PROJECT.md에 잠기지 않았다. 한 줄로 답이 정해지면 즉시 위 섹션에 반영하고 잠근다.

- **D1. 제품명/도메인** — `agentwallet`은 작업명. 최종 브랜드명 미정.
- **D2. Stripe 계정 가용성** — Ebsilon Stripe Atlas 계정의 charge 가능 여부 확인 필요. 결과에 따라 vault+PSP 조합 확정.
- **D3. 페르소나 디폴트** — 첫 1년 타겟: 개인 개발자/AI 빌더 우선 (B2C-스러운 B2C) — 잠정. 잠금 전.
- **D4. 수익 모델** — 거래당 마진 vs 월 구독 vs 둘 다. 미정.
- **D5. 첫 머천트 화이트리스트 디폴트** — OpenAI/Anthropic/Vercel/Resend/Stripe 등 사전 시드 여부.
- **D6. off-session mandate 문구** — 보수적(머천트 단위 동의) vs 공격적(일괄 동의) 중 선택.
- **D7. 에이전트 토큰 만료 기본값** — 15분 (잠정), 사용자별 조정 가능 여부.
- **D8. 한국어/영어 UI 우선순위** — 첫 출시 언어.

---

## 9. MVP 빌드 단계 (7일 셸 기준 — 잠금)

각 단계는 끝나야 다음으로 넘어간다. 단계 내 작업은 병렬 가능.

### Day 1: 인프라 결정 + 셸
- D2 (Stripe 계정 상태) 확인 → vault+PSP 조합 잠금.
- 백엔드 언어 잠금 (D 기본: TypeScript).
- Postgres 스키마 초안 (users, payment_methods, agents, policies, payments, receipts, audit_log).
- Basis Theory 계정 + iframe 통합 셸.

### Day 2-3: 코어 결제 흐름
- vault 토큰 발급 + 저장 (Setup Intent 흐름).
- 에이전트 생성 + 정책 저장 + OAuth 토큰 발급.
- 정책 엔진 1차 (per-tx, monthly, merchant whitelist, HITL).
- 결제 API: vault token + PSP off-session charge.

### Day 4: HITL + 알림
- HITL 임계값 평가 + 승인 큐.
- Web Push + Resend 이메일.
- 사용자 승인/거절 콜백.

### Day 5: 익스텐션 1차
- 결제 승인 팝업 (Manifest V3, Service Worker + popup).
- 잔액/한도 위젯.
- 거래내역 + 영수증 표시.

### Day 6: SDK + MCP
- TypeScript SDK (`@agentwallet/sdk`) 1차.
- MCP 서버 (stdio + HTTP) — `pay`, `check_balance`, `list_allowed_merchants`.
- Python SDK는 v0.2로 미룬다.

### Day 7: 도그푸드 + 영상
- 본인 Claude/Cursor에 MCP 연결.
- 실제 OpenAI/Anthropic 크레딧 충전을 에이전트가 자율 결제하는 데모.
- 데모 영상 + landing 페이지 골격.

---

## 10. 핵심 데이터 모델 (잠금 전 — Day 1에 확정)

```
users
  id, email, created_at, kyc_status

payment_methods
  id, user_id, vault_token, psp, last4, brand, mandate_text, mandate_signed_at

agents
  id, user_id, name, oauth_secret_hash, created_at, status (active|paused|killed)

agent_policies
  agent_id, monthly_limit_cents, per_tx_limit_cents, hitl_threshold_cents,
  allowed_merchants[], blocked_categories[], active_hours_tz, active_hours_window,
  expires_at, updated_at

payments
  id, agent_id, user_id, payment_method_id, amount_cents, currency,
  merchant, description, status (requested|approved|denied|pending_hitl|succeeded|failed|refunded),
  reason, evidence_url, idempotency_key, created_at, settled_at,
  psp_charge_id, psp_metadata_json

audit_log
  id, agent_id, user_id, action, input_json, output_json, decision, created_at
```

---

## 11. 변경 이력

- 2026-05-20: 초안 작성. 컨셉(권한위임 모델) 잠금. 비목적 명시. PSP-agnostic 원칙 잠금. D1~D8 open decisions 식별.
