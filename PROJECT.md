# AgentWallet — PROJECT.md

> 단일 진실 소스. 코드와 이 문서가 어긋나면 코드가 틀린 것.

소유자: Junhyuk Lee (이준혁) · Ebsilon, Inc.
시작: 2026-05-20
상태: **MVP-α — 셀프 호스팅 단일 사용자**

---

## 1. 목적

AI 에이전트가 사용자 카드로 자율 결제하도록 — 단, 사용자가 한도를 걸 수 있게.
**"바이어 측 Stripe."** MetaMask가 dApp에 서명을 주듯, AgentWallet은 에이전트에 결제를 준다.

**MVP-α는 본인이 자기 Claude/Cursor에 쓰는 단일 사용자 셀프 호스팅 도구.** 출시 아님.

---

## 2. 페르소나

- **사용자 (본인)** — 자기 카드로 자기 에이전트가 결제하게 함
- **에이전트** — 사용자가 발급한 API key로 결제 요청
- **머천트** — 일반 카드 결제로 받음 (우리 존재 모름)

---

## 3. 핵심 유저 스토리

- **US-1.** 사용자는 카드를 한 번 추가한다 (Stripe Elements).
- **US-2.** 사용자는 에이전트를 만들고 한도(월/per-tx)를 설정한 뒤 API key를 받는다.
- **US-3.** 에이전트는 API key로 `POST /api/pay`를 호출해 결제한다 — `reason` 필수.
- **US-4.** 사용자는 대시보드에서 모든 결제 내역과 이유를 본다.
- **US-5.** 사용자는 에이전트를 즉시 kill switch로 차단한다.

---

## 4. 비목적 (MVP-α에서 안 함)

- ❌ 멀티 사용자 / 가입 / 로그인
- ❌ 이메일 HITL — 한도가 통제. 더 엄격하면 한도 낮춤.
- ❌ Issuing / 크립토 / ACH / 다중 통화
- ❌ Web Push / 익스텐션
- ❌ OAuth / refresh token — 단순 Bearer API key
- ❌ Basis Theory / vault 분리 — Stripe Customer가 vault

---

## 5. 아키텍처 (3 컴포넌트)

```
[Claude/Cursor] ──MCP stdio──> [bin/mcp.ts] ──HTTP──> [Next.js localhost:3000]
                                                              │
                                                              ├──> Stripe (vault + 차지)
                                                              └──> SQLite (~/.agentwallet/db.sqlite)
```

---

## 6. 기술 스택 (잠금)

| 레이어 | 선택 |
|---|---|
| 앱 | Next.js 15 App Router + TypeScript |
| DB | SQLite (Node 26 빌트인 `node:sqlite`) at `~/.agentwallet/db.sqlite` |
| 결제 | Stripe (Test mode, off_session PaymentIntent) |
| UI | Tailwind CSS (shadcn 없이) |
| 인증 | **없음** (localhost 전용). 에이전트만 Bearer API key |
| MCP | `bin/mcp.ts` — `@modelcontextprotocol/sdk` stdio |
| 패키지 매니저 | `pnpm` |

---

## 7. 원칙 3개

1. **사용자가 last word** — kill switch 1초 내 작동.
2. **모든 결제에 `reason`** — context 없으면 거절.
3. **PROJECT.md = 진실** — 새 기능은 PROJECT.md 먼저.

---

## 8. 데이터 모델

```sql
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- 단일 사용자 = 1행만
  stripe_customer_id TEXT,
  stripe_pm_id TEXT,
  card_last4 TEXT,
  card_brand TEXT,
  created_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  monthly_limit_cents INTEGER NOT NULL,
  per_tx_limit_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'killed'
  created_at INTEGER NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount_cents INTEGER NOT NULL,
  merchant TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'succeeded' | 'failed' | 'denied'
  stripe_pi_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, idempotency_key)
);
```

---

## 9. API

```
POST /api/setup-intent          # Stripe SetupIntent client_secret 반환
POST /api/cards/confirm         # SetupIntent succeeded 후 pm 저장
POST /api/agents                # 에이전트 생성 → API key (raw, 1회만)
GET  /api/agents                # 목록
POST /api/agents/:id/kill       # kill switch
POST /api/pay                   # 에이전트 호출 (Bearer + amount + merchant + reason + idempotency_key)
GET  /api/payments              # 대시보드용
```

---

## 10. 페이지

```
/                    # 대시보드 (카드 상태 + 에이전트 목록 + 최근 결제 + kill switch)
/setup               # 카드 추가 (Stripe Elements)
/agents/new          # 에이전트 생성 폼
```

---

## 11. 빌드 단계 (4 phase)

| Phase | 작업 | 병렬 가능? |
|---|---|---|
| **0. 스캐폴딩** | Next.js + Tailwind + SQLite 스키마 + types + 레이아웃 | ❌ 단일 |
| **1. 카드 + 에이전트** | Lane A (카드 setup 흐름), Lane B (에이전트 CRUD + UI) | ✅ 2 lane 병렬 |
| **2. 결제 엔진** | `POST /api/pay` + 정책 함수 + Stripe charge + idempotency | ❌ 단일 (A+B 의존) |
| **3. MCP + 대시보드** | Lane C (MCP 서버 + 클라이언트 SDK), Lane D (대시보드 + kill switch UI) | ✅ 2 lane 병렬 |

---

## 12. 미해결 결정

- **D1.** 제품명/도메인 — `agentwallet` 작업명 그대로
- **D2.** 머천트 화이트리스트 — MVP-α는 없음. 한도만으로 통제 (v2)

---

## 변경 이력

- **2026-05-20**: SQLite을 Node 26 빌트인 `node:sqlite`로 변경 (native deps 0개).
- **2026-05-20**: 단순화. 셀프 호스팅 단일 사용자. 3 컴포넌트, 4 phase. Basis Theory/Clerk/Resend/OAuth/익스텐션 제거.
- **2026-05-20**: 초안.
