# رسالة افتتاحية للدردشة الجديدة — THE BALANCE / GROUP 01

**هذه رسالة جاهزة للنسخ واللصق في أول رسالة للدردشة الجديدة. اقرأها كاملة قبل البدء.**

---

## تحية وتمهيد

السلام عليك. أنت نموذج تطوير جديد تتولى استكمال مشروع **الميزان — THE BALANCE**. هذه رسالة افتتاحية شاملة تمنحك كل السياق اللازم لاستئناف العمل من النقطة التي توقفنا عندها، دون إعادة اكتشاف تاريخ المشروع من الصفر.

اقرأ هذه الرسالة كاملة، ثم اقرأ الوثائق المُشار إليها، ثم انتظر تعليمات المؤسس قبل كتابة أي شيفرة.

---

## 1. تعريف المشروع وهويته

**اسم المشروع:** THE BALANCE — الميزان
**المستودع:** `mayakilzy/The-Balance` (عام على GitHub)
**مستودع الوثائق:** `mayakilzy/repo-info/The-Balance-Doc`

**الغاية الأساسية:**
الميزان منصة ذكاء دولة مبنية على الأدلة، موجّهة أساساً للحكومات الشرعية المخولة. تساعدها على:
1. فهم الحالة الفعلية للدولة (خط أساس موثق بالأدلة)
2. تصميم استراتيجيات إصلاح مترابطة متعددة القطاعات (بدائل قابلة للمراجعة)
3. مرافقة التنفيذ (تتبع + قياس)
4. قياس النتائج باستقلال (مرصد)
5. حماية ذاكرة الدولة الاستراتيجية عبر تغير الحكومات (استمرارية)

**الجمهور المستهدف:** الحكومة أولاً — مكاتب الوزراء، وحدات الاستراتيجية، الوزارات، هيئات التقييم المستقلة. ثم الباحثون والجمهور عبر بوابات قراءة محمية.

**الميزان عالمي، ليس مخصصاً لسوريا وحدها.** سوريا هي أول دراسة حالة معمقة، لا تعريف المنتج. أي بلد يمكن إضافة Country Pack خاص به.

**الفلسفة الهندسية:** Small in Code, Large in Capability — شيفرة صغيرة، قدرة كبيرة. لا تعقيدات تشغيلية بلا ضرورة، لا حدود اعتباطية، لا إعادة اختراع ما يعمل.

---

## 2. المبادئ العلمية المعتمدة (ملزمة)

هذه المبادئ من Master Blueprint §2 وهي ملزمة لكل مرحلة:

1. **الأدلة قبل الاستنتاج** — كل ادعاء مرتبط بمصدر وتاريخ وطريقة معالجة
2. **"لا نعرف" نتيجة صالحة** — النظام يمتنع عن القياس أو الاستنتاج عند نقص البيانات، ولا يختلق قيماً
3. **تعدد المصادر والاستقلالية** — النسخ المتطابقة أو المقتبسة لا تُحتسب مصادر مستقلة
4. **الأدلة المضادة** — طلب بحث مضاد موثق للادعاءات عالية الأثر
5. **فصل المستويات** — الادعاء ≠ الملاحظة ≠ التفسير ≠ الارتباط ≠ السببية ≠ التوصية
6. **متجه الدولة** — أبعاد منفصلة (الوضع، الاتجاه، الجودة، الإنصاف، التنفيذ)؛ لا رقم سحري واحد
7. **معايرة عدم اليقين** — لا نسب ثقة مصطنعة؛ نطاقات موثقة حين تصلح
8. **الصلاحية الزمنية** — تاريخ الواقع ≠ تاريخ الاكتشاف ≠ إصدارات التصحيح
9. **القابلية للنقل** — لا نقل آلي لنموذج دولة خارج سياقها
10. **السيادة البشرية** — لا قانون ولا موازنة ولا صرف ولا إلغاء برنامج من وكلاء AI
11. **الاستمرارية دون قفل** — حفظ المعرفة دون فرض سياسة قديمة على حكومة جديدة
12. **إعادة الإنتاج** — مصدر + نموذج + نسخة أداة + بيانات مدخلة + مخرج قابل لإعادة الحساب
13. **الأمان والخصوصية** — أصغر امتياز، عزل مستأجر، تفويض، تدقيق، عدم نشر الافتراضات الحساسة

---

## 3. تاريخ تطوير GROUP 00 ونتائجه

اكتملت مجموعة التأسيس G00 بنجاح. 11 مهمة (00-00 إلى 00-11) اجتازت معايير القبول بأدلة قابلة للتحقق في CI.

### ما بُني في G00:

**قاعدة البيانات:** 16 هجرة، 22 نموذج Prisma (8 جداول PUBLIC + 14 جدول PRIVATE)، RLS مفعّل (ENABLE + FORCE) على جميع الجداول الخاصة، 4 جداول append-only (audit_log, decision_events, events, task_events)، pgvector للبحث الدلالي 384-بُعد.

**المصادقة والصلاحيات:** Auth.js v5 مع CredentialsProvider (bcrypt cost 12)، JWT يحمل userId + tenantId + roleCode + membershipStatus، 4 أدوار (admin, analyst, reviewer, observer)، `requirePermissionWithCurrentRole` يتحقق من الدور الحالي في DB لا من JWT القديم.

**ثلاثة أدوار DB:** balance_admin (BYPASSRLS للهجرات)، balance_app (RLS للتشغيل)، balance_auth (للقراءة فقط لمسار المصادقة).

**Evidence Fabric:** إنشاء أدلةtenant-scoped، بحث pgvector، تتبع verification_status و support_stance و independence_group.

**Strategy Contracts:** Strategy → StrategyVersion (غير قابل للتعديل بعد الاعتماد) → Decision (يأخذ snapshot من الأدلة). حالات: draft → proposed → approved → active → amended → retired.

**Durable Task Runtime:** fencing token (claimGeneration)، lease (60s افتراضياً)، idempotency (UNIQUE partial index)، SELECT FOR UPDATE SKIP LOCKED للمطالبة، reclaim ذري للعامل المتعطل.

**Balance Master Stub:** `executeNextTaskWithProvider(session, provider)` — يستخدم LLMProvider.

**Capability Registry:** ExpertAdapter contract (`execute(input) → { output, provider, simulated }`)، StubAdapter (محاكى صريح)، **لا fallback صامت** — المهايئ المفقود يفشل لا يحاكي.

**Security و Observability:** CSP + 7 ترويسات أمان، Rate limiting (4 مسارات)، Trusted IP gating (TRUSTED_PROXY)، `buildApiErrorResponse()` (لا حقل detail للأخطاء غير المتوقعة)، `sanitizeForLog()` (9 أنماط سرية تُنزَّع قبل pino)، مقاييس in-process.

**UI (6 صفحات، RTL عربي، responsive):** /login، /، /tasks، /evidence، /capabilities، /strategies.

**API (16 مسار):** health، meta، countries، auth (signin/signout/me/switch-tenant)، evidence (CRUD/search/verify)، tasks (CRUD/execute)، capabilities (list/invoke)، _metrics.

**اختبارات (237 ناجح، 10 متخطى، 18 ملف):** 7 ملفات وحدة (82 اختبار)، 10 ملفات تكامل (145 اختبار)، 1 ملف e2e (10 اختبارات)، 1 ملف Playwright (4 اختبارات).

**CI (سيرتا عمل، كلاهما أخضر):** الأساسي (19 خطوة)، الاستعادة (7 مراحل).

### ما هو Stub/Mock (مُعلن بصدق):
- **LLM Provider:** StubProvider (SIMULATED) — كل استجابة تحمل `simulated: true`
- **Balance Master:** يستخدم StubProvider
- **StubAdapter:** `readiness: "stub"` في DB + UI
- **المقاييس:** in-process (لا توزيع)
- **Rate limiting:** in-memory (لا توزيع)

### ما لم يُنفَّذ (مؤجل):
- مزودات LLM حقيقية (zai, openai, anthropic) — العقد جاهز، لا مهايئ
- ExpertAdapters حقيقية — العقد جاهز، لا تنفيذات
- مقاييس موزعة (Prometheus) — قبل التوسع
- Rate limiting موزع (Redis) — قبل التوسع
- WAL archiving / PITR — لتقوية الإنتاج
- إدارة أسرار خارجية (Vault/SOPS) — لتقوية الإنتاج

### SHA المعتمد النهائي لـ G00:
`dcbb8961dd588bb9e66a9076bc4e62625482a56f`

### آخر تشغيلَي CI ناجحين:
- CI الأساسي #73: https://github.com/mayakilzy/The-Balance/actions/runs/38985956186
- الاستعادة #11: https://github.com/mayakilzy/The-Balance/actions/runs/38985956161

---

## 4. القرارات الهندسية الملزمة (لا تُعاد فتحها تلقائياً)

هذه قرارات اعتمدها المؤسس وهي ملزمة. إعادة فتح أي منها تتطلب موافقة صريحة:

1. **لا تُعِد بناء الأنظمة التأسيسية الناجحة** — المصادقة، RLS، Evidence Fabric، Strategy Contracts، Task Runtime، Capability Registry مكتملة. G01 يبني فوقها لا ي Replaceها.

2. **استفد من المكونات القائمة** — `LLMProvider` interface، `ExpertAdapter` contract، `withAuthenticatedTenant`، `writeAudit`، `buildApiErrorResponse`، `sanitizeForLog`، fencing token — كلها تُستخدم كما هي.

3. **حافظ على RLS + RBAC + سجلات التدقيق** — كل جداول G01 الجديدة يجب أن تكون PRIVATE مع ENABLE+FORCE RLS. كل إجراء مُميَّز يُسجَّل في audit_log.

4. **حافظ على عقود LLMProvider و ExpertAdapter** — G01 يستخدم الواجهة (StubProvider افتراضياً). مزود حقيقي هو خطوة منفصلة مُعلنة، لا استبدال صامت.

5. **لا تقدم نتائج المحاكاة كحقيقية** — كل استجابة تعتمد على LLM يجب أن تحمل `simulated: true` عند استخدام StubProvider. واجهة المستخدم تعرض "SIMULATED".

6. **لا تمنح AI سلطة اعتماد قرارات سيادية** — لا قانون ولا موازنة ولا صرف ولا إلغاء برنامج ولا اعتماد استراتيجية من AI. الموافقة البشرية مطلوبة لكل انتقال إلى `approved`/`active`. `strategy:compose` (مسودة) ≠ `strategy:approve` (اعتماد) — فصل الصلاحيات.

7. **لا تعقيدات تشغيلية بلا ضرورة** — لا Kubernetes، لا microservices، لا swarm engine جديد، لا مستودعات منفصلة. مستودع واحد، monolith معياري.

8. **لا حدود اعتباطية** على زمن التنفيذ أو استهلاك الرموز في المراحل التجريبية.

9. **أدلة تشغيل حقيقية عند إعلان PASS** — لا مهمة PASS لمجرد نجاح الاختبارات. حالة الاستخدام End-to-End يجب أن تعمل، المحاكاة/المزودون مُعلنون صراحةً، صلاحيات المستخدم مُراجعة، SHA + دليل إعادة التنفيذ مُسجَّل.

10. **Progressive Mission Authoring** — مهام المجموعة التالية تُكتب فقط بعد اعتماد تقرير المجموعة السابقة. لا توليد مسبق لمهام G02–G05.

11. **0% إعادة استخدام لكود swarm-engine** — مرجع أنماط فقط (ADR-0011).

12. **"لا نعرف" نتيجة صالحة** — النظام يقول "unknown" عند نقص البيانات، ولا يختلق.

13. **الأدلة المضادة إلزامية** — الادعاءات عالية الأثر يجب أن تتضمن أدلة معارضة.

14. **لا دقة زائفة** — تقديرات الموازنة نطاقات مع افتراضات. الثقة وصفية ("عالية/متوسطة/منخفضة" + سبب)، لا نسبة مصطنعة.

---

## 5. الحالة الحالية لـ GROUP 01

### أهداف State Builder:
دولة ذات خط أساس وأهداف تستطيع الحصول على مسودات استراتيجية متعددة القطاعات قابلة للمراجعة والاعتماد.

### المكونات المطلوبة (من Roadmap §4):
1. State Baseline
2. Gap Analysis
3. National Strategy Composer
4. Institutional Design
5. Portfolio & Dependency Graph
6. Budget/Financing Estimates
7. Implementation Roadmap
8. Scenario Comparisons
9. Development Advisor v1
10. Human Approval

### اختبار القبول T1:
ملف بلد اصطناعي أو مصادر حالة موثقة → اقتراح بدائل متعددة → تبعيات وتكاليف مشروطة وملفات عدم يقين → موافقة مستخدم مخول تنشئ Strategy Version نشطة مع audit.

**عدم الاعتماد يتركها مسودة. لا تتسلل توصية AI إلى وضع Approved.**

### حالة GROUP 01 Mission Pack:
**مسودة جاهزة لمراجعة المؤسس — غير معتمدة بعد.**

ملف الحزمة: `docs/mission-reports/G01/GROUP_01_MISSION_PACK.md` (745 سطراً، 11 مهمة من 01-00 إلى 01-10).

**مهم: لم تُكتب أي شيفرة G01. لم تُنشأ أي هجرة G01. المؤسس لم يعتمد التنفيذ بعد.**

### ما يجب بناؤه في G01:
- 8 نماذج Prisma جديدة (Objective, Program, Project, BudgetLine, Dependency, RiskRegister, Assumption, CountryPackConfig)
- 7 ADRs جديدة (ADR-0013 إلى ADR-0019)
- 9 وحدات خدمة في `src/lib/state-builder/`
- ~116 اختباراً جديداً
- اختبار Playwright E2E لـ T1
- صلاحيات جديدة: `baseline:read/compute`, `gap:read`, `strategy:compose/approve`, `program:read`, `portfolio:read`, `budget:read`, `advisor:invoke`

### ما يجب تجنبه في G01:
1. لا نموذج توقعات اقتصادي شامل
2. لا تطبيق قطاعي كامل لكل وزارة
3. لا مزود LLM حي (Stub فقط مع `simulated: true`)
4. لا AI auto-approval
5. لا بيانات حكومية حقيقية (Demolandia أو مصادر موثقة فقط)
6. لا تكامل نظام مالي خارجي
7. لا ادعاء أثر سياسي واقعي
8. لا إعادة بناء عقود G00

---

## 6. الأدوات والمستودعات ومسارات الوثائق

### بيئة التطوير:
- **OS:** Linux (حاوية Ubuntu)
- **Runtime:** Bun 1.3.14 (أساسي)، Node.js 24+ (احتياطي)
- **مستودع محلي:** `/home/z/my-project/repos/The-Balance/`
- **Worklog مشترك:** `/home/z/my-project/worklog.md`
- **سكرِبتات التوليد:** `/home/z/my-project/scripts/`
- **مجلد التسليم:** `/home/z/my-project/download/`

### التقنيات (ADR-0001):
Next.js 16 + TypeScript 5 + PostgreSQL 16 + pgvector + Prisma 6 + Auth.js v5 + Zod 4 + pino + Vitest + Playwright + Tailwind CSS 4

### الوثائق الأساسية (اقرأها بهذا الترتيب):
1. `docs/handoffs/GROUP_01_MASTER_CONTEXT_HANDOFF.md` — السياق الشامل
2. `docs/mission-reports/G01/GROUP_01_MISSION_PACK.md` — حزمة مهام G01
3. `docs/mission-reports/G00/GROUP_00_FINAL_REVIEW.md` — المراجعة الختامية لـ G00
4. `docs/mission-reports/G00/GROUP_01_READINESS_HANDOFF.md` — ما يرثه G01
5. `docs/mission-reports/G00/GROUP_00_KNOWN_LIMITATIONS.md` — القيود المعروفة
6. `docs/RUNBOOK.md` — دليل التشغيل والاستعادة
7. `docs/handoffs/GROUP_01_REFERENCE_MAP.md` — خريطة الملفات
8. `docs/handoffs/GITHUB_ACCESS_CONTINUITY.md` — إرشادات الوصول الآمن إلى GitHub

### ADRs (12 معتمدة):
`docs/adr/ADR-0001-*.md` إلى `ADR-0012-*.md` — كلها ملزمة لـ G01.

### مراجع خارجية (في mayakilzy/repo-info/The-Balance-Doc):
- `01_The_Balance_Master_Blueprint_v2.0.md` — المخطط الرئيسي
- `02_The_Balance_Six_Group_Development_Roadmap_v1.0.md` — خارطة المجموعات الست

---

## 7. ما تم اختباره والتحقق منه

### تم إثباته تشغيلياً في CI:
- التثبيت النظيف من قاعدة فارغة (16 هجرة + بذور)
- عزل المستأجرين عبر RLS (19 اختبار)
- المصادقة + RBAC (20 + 37 اختبار)
- Evidence Fabric + pgvector (15 اختبار)
- Strategy Contracts + immutability (18 اختبار)
- Durable Task Runtime + fencing + reclaim (13 + 9 اختبار)
- Capability Registry + no silent fallback (13 اختبار)
- Security: error sanitization + log sanitization + trusted IP (24 + 26 + 12 اختبار)
- Playwright E2E: login → task → logout (4 اختبارات)
- إعادة تشغيل التطبيق + بقاء البيانات
- تعطل العامل + استعادة المهمة
- نسخ احتياطي + استعادة قاعدة البيانات (مع اختبار سلبي للنسخة التالفة)
- بناء الإنتاج

### لم يتم إثباته بعد (مؤجل):
- أثر سياسي واقعي (G01 لا يثبت ذلك — يثبت الهندسة + الصدق العلمي فقط)
- تكامل مع مزود LLM حقيقي
- نشر متعدد العمليات / متعدد المناطق
- تكامل مع نظام مالي حكومي حقيقي

---

## 8. المرحلة التالية المطلوبة بالضبط

**انتظر موافقة المؤسس على GROUP 01 Mission Pack.**

المؤسس سيقرر:
```
GROUP_01_MISSION_PACK = APPROVED / APPROVED WITH CHANGES / REJECTED
Implementation may begin: YES / NO
First mission to execute: 01-00
```

**لا تبدأ كتابة أي شيفرة G01 قبل الموافقة الصريحة.**

عند الموافقة، المهمة الأولى هي **01-00 — G01 Bootstrap + Country Pack Extension**:
- إنشاء هجرة 0017 مع 8 نماذج جديدة
- توسيع بذور Demolandia v2
- إنشاء `src/lib/state-builder/objective-service.ts` و `country-pack-service.ts`
- RLS على جميع الجداول الجديدة
- اختبارات التكامل

---

## 9. طريقة تقديم تقارير المهام والـCommit والـCI

### قالب تقرير المهمة (من Roadmap §12):
```text
MISSION_ID = ...
TARGET_GROUP = ...
BASE_COMMIT = ...
FINAL_COMMIT = ...
WORKTREE = clean / justified
DELIVERED = paths and capabilities
TEST_COMMANDS = exact commands + outputs
LIVE_EVIDENCE = real / mocked / not tested (never conflate)
SECURITY_CHECKS = authz, tenant isolation, secrets, unsafe inputs
CONTRACT_CHANGES = backward compatible? migrations?
OPEN_DEFECTS = ID/severity/reproduction
DECISION_REQUESTS = any scope/contract change
ACCEPTANCE = PASS / PARTIAL / FAIL (evidence references)
NEXT_STEP = specific mission or group gate
```

### أسلوب Commit:
```bash
# رسالة الالتزام: <type>(<mission>): <subject>
# الأنواع: feat, fix, docs, refactor, test, chore
# أمثلة:
# feat(01-00): G01 bootstrap + country pack extension
# fix(01-03): use set +e for negative test

git commit -m "feat(01-00): G01 bootstrap + country pack extension

Description of what was built...
- New migration 0017
- 8 new Prisma models
- RLS on all new tables
- Tests: N passed

Verified:
- typecheck: PASS
- lint: PASS
- unit tests: N passed"
```

### مراقبة CI:
```bash
# فحص حالة التشغيل
curl -s -H "Authorization: token <PAT>" \
  "https://api.github.com/repos/mayakilzy/The-Balance/actions/runs?per_page=5" \
  | jq -r '.workflow_runs[] | "Run #\(.run_number): \(.name) — \(.status)/\(.conclusion)"'

# انتظر حتى اكتمال التشغيل
sleep 360
# ثم تحقق من النتيجة
```

### معايير PASS:
- جميع خطوات CI خضراء
- اختبارات تكامل + وحدة ناجحة
- بناء الإنتاج ناجح
- Playwright E2E ناجح (للمهام التي تتطلب UI)
- `simulated: true` موجود في كل استجابة تعتمد على LLM
- لا أسرار في السجلات أو الاستجابات
- SHA مُسجَّل + رابط CI

---

## 10. قواعد التعامل مع الأسرار والمصادقة على GitHub

### قواعد ملزمة (لا تنتهكها أبداً):

1. **لا تضع** PAT أو API Key أو Password في أي ملف ملتزم (`.md`, `.txt`, `.env`, شيفرة، إعدادات)
2. **لا تطبع** قيمة الرمز في الطرفية أو التقارير أو نتائج الاختبارات
3. **لا تنشئ** نسخة من الرمز داخل مستودع Git، حتى لو كان خاصاً
4. **لا تضع** الرمز مباشرة في Git remote URL أو أوامر قد تُحفظ في سجل الطرفية
5. **استخدم** Git Credential Manager أو أداة تخزين أسرار معتمدة إذا كانت متاحة
6. **إذا كانت بيانات الاعتماد موجودة مسبقاً** في مخزن آمن محلي، تحقق من إمكانية استخدامها دون استخراج قيمتها
7. **لا تنشئ** ملفات إضافية تحتوي على نسخة مكشوفة من الرمز
8. **لا تنقل** ملف الاعتماد السري ضمن حزمة التسليم أو مرفقات الدردشة
9. **إذا لم تشارك الجلسة الجديدة مخزن الاعتمادات** مع الجلسة الحالية، اذكر بوضوح أن إعادة الاتصال بـGitHub قد تتطلب تفويضاً جديداً من المالك
10. **لا تستخرج** الرمز من `GeneralGH.zip` أو أي مصدر قديم ولا تعِد تخزينه بصيغة جديدة لمجرد تجهيز التسليم

### كيفية التحقق من توفر الوصول إلى GitHub (دون كشف الرمز):
```bash
# فحص وجود ملف الاعتماد (دون طباعة محتواه)
test -f <path-to-credential-file> && echo "EXISTS" || echo "MISSING"

# فحص dry-run (لا يدفع فعلياً، يختبر المصادقة)
git push --dry-run origin main 2>&1 | head -5
```

### إذا لم يكن الوصول متاحاً:
أخبر المؤسس صراحةً:
> "وصول الدفع إلى GitHub غير متاح في هذه الجلسة. يجب توفير PAT جديد عبر قناة آمنة قبل إمكانية دفع الشيفرة."

اقرأ `docs/handoffs/GITHUB_ACCESS_CONTINUITY.md` للتفاصيل الكاملة.

---

## 11. تعليمات استئناف العمل من آخر SHA معتمد

### SHA المعتمد الحالي:
`dcbb8961dd588bb9e66a9076bc4e62625482a56f` (G00 النهائي)
آخر التزام: `476f6db` (حزمة مهام G01 + تصحيحات وثائق G00)

### خطوات الاستئناف:

1. **تحقق من حالة المستودع:**
   ```bash
   cd /home/z/my-project/repos/The-Balance
   git status
   git log --oneline -5
   git fetch origin
   git log --oneline origin/main -3
   ```

2. **إذا كان المستودع مفقوداً، استنسخه من جديد:**
   ```bash
   mkdir -p /home/z/my-project/repos
   cd /home/z/my-project/repos
   git clone https://github.com/mayakilzy/The-Balance.git
   cd The-Balance
   bun install --frozen-lockfile
   bunx prisma generate
   ```

3. **اقرأ الـworklog المشترك:**
   ```bash
   tail -100 /home/z/my-project/worklog.md
   ```

4. **اقرأ وثائق التسليم بهذا الترتيب:**
   - `docs/handoffs/GROUP_01_MASTER_CONTEXT_HANDOFF.md`
   - `docs/mission-reports/G01/GROUP_01_MISSION_PACK.md`
   - `docs/mission-reports/G00/GROUP_00_FINAL_REVIEW.md`

5. **تحقق من CI الأخير:**
   - CI الأساسي: https://github.com/mayakilzy/The-Balance/actions
   - آخر تشغيل ناجح: #73 (الأساسي) + #11 (الاستعادة)

6. **انتظر تعليمات المؤسس** قبل كتابة أي شيفرة G01.

---

## 12. عدم إعادة بناء أو تكرار الأعمال المكتملة

### ما يجب استخدامه كما هو (لا تعِد بناءه):
- Auth.js v5 (`src/lib/auth.ts`)
- RLS policies (جميع الجداول الـ14 الخاصة)
- Task Runtime fencing (`src/lib/task-service.ts`)
- Strategy immutability trigger
- Audit log append-only enforcement
- `LLMProvider` interface + `StubProvider`
- `ExpertAdapter` contract + `StubAdapter`
- `withAuthenticatedTenant` + `withPublicScope`
- `buildApiErrorResponse` + `sanitizeForLog`
- `writeAudit` + ipHash
- middleware (CSP, rate limiting, trusted IP)
- CI workflows (ci.yml + fresh-install-recovery.yml)
- سكربتات الاستعادة (fresh-install-verify.sh, verify-restored-db.sh, backup-restore-test.sh, restart-verify.sh)

### ما يجب توسيعه (لا تعِد بناءه، أضف فوقه):
- Prisma schema (نماذج جديدة في هجرة جديدة، لا تعِد تعديل الهجرات القائمة)
- RLS policies (أضف للجداول الجديدة، لا تُضعف القائمة)
- API routes (أضف مسارات جديدة، لا تعِد تعديل القائمة)
- UI pages (أضف صفحات جديدة، لا تعِد بناء القائمة)
- اختبارات (أضف ملفات جديدة، لا تعِد تعديل القائمة)

### ما يجب عدم لمسه إطلاقاً:
- هجرات G00 (0001–0016) — لا تعِد تعديلها
- ADRs المعتمدة (0001–0012) — لا تعِد فتحها دون موافقة
- سياسات RLS القائمة — لا تُضعفها
- trigger الـimmutability للاستراتيجيات — لا تُعطّله
- REVOKE UPDATE/DELETE على الجداول append-only — لا تُلغِه

---

## 13. توقعاتي منك

1. **اقرأ كل الوثائق المُشار إليها** قبل البدء
2. **لا تكتب شيفرة G01** قبل موافقة المؤسس
3. **اسأل** إذا كان أي شيء غير واضح — لا تخمِّن
4. **كن صادقاً** بشأن ما هو حقيقي vs محاكى vs غير مُختبَر
5. **التزم بالمبادئ العلمية** — "unknown" صالح، الأدلة المضادة إلزامية، لا دقة زائفة
6. **احترم السيادة البشرية** — لا AI auto-approval أبداً
7. **سجِّل كل شيء** في الـworklog + تقارير المهام
8. **لا تنتهك قواعد الأسرار** — راجع §10 أعلاه
9. **استخدم الـRUNBOOK** لإجراءات التشغيل والاستعادة
10. **قدم أدلة قابلة للتحقق** — SHA + روابط CI + نتائج اختبارات

---

## الخلاصة

المشروع في نقطة آمنة. مجموعة التأسيس G00 مكتملة بالكامل، والمنصة تعمل وتُستعاد بنجاح. حزمة مهام G01 جاهزة للمراجعة. دورك هو استئناف العمل من هذه النقطة، باحترام كل ما بُني، وتطبيق المبادئ العلمية والهندسية المعتمدة.

**توقف الآن وانتظر تعليمات المؤسس. لا تبدأ كتابة شيفرة G01 قبل الموافقة الصريحة على حزمة المهام.**

---

*هذه الرسالة كاملة ومكتفية ذاتياً. الدردشة الجديدة يمكنها قراءتها ثم البدء من نقطة التوقف نفسها.*
