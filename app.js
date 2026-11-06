/* 고객 한마디 분류기 — 화면.
 *
 * 흐름: 문장 → 가림(mask.js, 브라우저 안) → AI(api/classify) → 실패하면 규칙(rules.js)
 * 채점: 정답 100건을 규칙으로, 또는 AI로(10건씩 열 번) 돌려 맞힌 비율을 잰다.
 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const S = { criteria: null, test: [], practice: [], aiResults: null, serverDefault: null };
  // AI 채점 때 한 번에 보내는 문장 수. 서버의 MAX_TEXTS(20) 보다 작게 둔다 —
  // 묶음이 작을수록 모델이 느려도 서버의 대기 한도(60초) 안에 답한다.
  const BATCH = 10;

  async function load() {
    const [c, t, p] = await Promise.all([
      fetch("criteria.json").then(r => r.json()),
      fetch("data/answer100.json").then(r => r.json()),
      fetch("data/practice200.json").then(r => r.json()),
    ]);
    S.criteria = c; S.test = t; S.practice = p;
    renderCriteria();
  }

  // ── 탭 ──────────────────────────────────────────────
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
    ["try", "score", "rules"].forEach(k => { $("#tab-" + k).hidden = k !== b.dataset.tab; });
  }));

  // ── AI 모델 고르기 ───────────────────────────────────
  // 모델 이름은 자주 바뀐다. 아래 5개는 2026-11-06 에 공식 가격표(aistudio.google.com/docs/pricing)에서
  // «Free tier 무료»로 표시된 글쓰기(텍스트) 모델 중에서 직접 확인해 골랐다.
  // 음성·TTS·번역·임베딩 모델과 지원 중단 표시가 붙은 모델(2.5 Pro · 2.5 Flash)은 뺐다.
  // 무료 한도(하루 요청 수)는 가격표에 없고 AI Studio 에 로그인해야 보인다 — 근거를 못 찾았다.
  // 그래서 순서는 «추정»이다: 한도 순이 아니라 «최신·일반 모델 먼저, 프리뷰는 맨 뒤».
  // 목록에 없는 이름은 «직접 입력…» 으로 쓴다.
  const MODELS = [
    { id: "gemini-3.8-flash" },
    { id: "gemini-3.5-flash-lite" },
    { id: "gemini-3.1-flash-lite" },
    { id: "gemini-2.5-flash-lite" },
    { id: "gemini-3-flash-preview", tag: "프리뷰" },
  ];
  const SEL_KEY = "classifier.model.sel", CUSTOM_KEY = "classifier.model.custom", CUSTOM = "__custom__";
  const selEl = $("#model-select"), customEl = $("#model-custom");

  // 시크릿 창 등에서 localStorage 를 못 써도 앱은 멀쩡히 돈다
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 기억만 못 할 뿐이다 */ } }

  function addOption(value, label) {
    const o = document.createElement("option");
    o.value = value; o.textContent = label; selEl.appendChild(o);
  }
  addOption("", "서버 기본값");
  MODELS.forEach(m => addOption(m.id, m.id + (m.tag ? ` (${m.tag})` : "")));
  addOption(CUSTOM, "직접 입력…");

  // 서버에 보낼 모델 이름. «서버 기본값»(또는 빈 직접 입력)이면 빈 문자열
  function currentModel() { return selEl.value === CUSTOM ? customEl.value.trim() : selEl.value; }

  function renderModelLine() {
    const m = currentModel();
    $("#model-line").textContent = m ? `지금 ${m} 로 호출합니다`
      : S.serverDefault ? `서버 기본값 — 지금 ${S.serverDefault} 로 호출합니다`
      : "서버 기본값으로 호출합니다 — 서버에 닿으면 그 이름이 여기 보입니다";
  }

  const savedSel = lsGet(SEL_KEY);
  if ([...selEl.options].some(o => o.value === savedSel)) selEl.value = savedSel;
  customEl.value = lsGet(CUSTOM_KEY) || "";
  customEl.hidden = selEl.value !== CUSTOM;
  renderModelLine();

  selEl.addEventListener("change", () => {
    lsSet(SEL_KEY, selEl.value);
    customEl.hidden = selEl.value !== CUSTOM;
    if (!customEl.hidden) customEl.focus();
    renderModelLine();
  });
  customEl.addEventListener("input", () => { lsSet(CUSTOM_KEY, customEl.value); renderModelLine(); });

  // «서버 기본값» 이 어떤 모델인지 서버에 묻는다. 로컬에는 서버 함수가 없어 실패해도 정상이다
  async function loadServerDefault() {
    try {
      const r = await fetch("api/classify");
      if (!r.ok) return;
      const d = await r.json();
      if (d && typeof d.default === "string") { S.serverDefault = d.default; renderModelLine(); }
    } catch (e) { /* 서버 함수 없음 */ }
  }

  // ── AI 호출 ─────────────────────────────────────────
  async function askAI(maskedTexts, model = currentModel()) {
    try {
      const r = await fetch("api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: maskedTexts, criteria: S.criteria, model }),
      });
      if (!r.ok) return { results: null, reason: `서버 함수가 없습니다 (${r.status}) — 배포하면 생깁니다` };
      return await r.json();
    } catch (e) {
      return { results: null, reason: "서버 함수에 닿지 못했습니다" };
    }
  }

  function chips(el, res) {
    el.innerHTML = ["category", "sentiment", "urgency"]
      .map(k => `<span class="chip ${res[k]}">${res[k]}</span>`).join("");
  }

  // ── 분류해 보기 ─────────────────────────────────────
  $("#btn-sample").addEventListener("click", () => {
    const r = S.practice[Math.floor(Math.random() * S.practice.length)];
    $("#input").value = r.text;
  });

  $("#btn-classify").addEventListener("click", async () => {
    const text = $("#input").value.trim();
    if (!text) return;
    const btn = $("#btn-classify");
    btn.disabled = true; btn.textContent = "분류 중…";

    const m = Mask.mask(text);
    $("#sent").hidden = false;
    $("#sent-text").textContent = m.masked;
    $("#sent-found").innerHTML = m.found.length
      ? m.found.map(f => `<span class="tag">${f.type} 가림</span>`).join("")
      : `<span class="muted">가린 것 없음</span>`;

    const rule = Rules.classify(m.masked, S.criteria);
    const ai = await askAI([m.masked]);
    const got = ai.results && ai.results[0];

    $("#result").hidden = false;
    if (got) {
      $("#main-by").textContent = "AI · " + (ai.model || "");
      chips($("#main-chips"), got);
      $("#main-reason").textContent = got.reason || "";
      $("#note").hidden = true;
    } else {
      $("#main-by").textContent = "규칙";
      chips($("#main-chips"), rule);
      $("#main-reason").textContent = `분류: ${rule.why.category} · 감정: ${rule.why.sentiment} · 긴급도: ${rule.why.urgency}`;
      $("#note").hidden = false;
      $("#note").textContent = `AI 없이 규칙으로만 분류했습니다 — ${ai.reason || "AI 응답 없음"}`;
    }
    chips($("#rule-chips"), rule);
    $("#rule-reason").textContent = `분류: ${rule.why.category}`;
    $("#card-rule").hidden = !got;

    btn.disabled = false; btn.textContent = "분류하기";
  });

  // ── 채점 ───────────────────────────────────────────
  function pct(x) { return x.toFixed(x % 1 ? 1 : 0) + "%"; }

  function showScore(who, s) {
    $("#score-table").hidden = false;
    for (const k of ["category", "sentiment", "urgency"]) {
      document.querySelector(`[data-k="${who}-${k}"]`).textContent = pct(s.accuracy[k]);
    }
    document.querySelector(`[data-k="${who}-all"]`).textContent = `${s.n - s.wrong.length} / ${s.n}`;
    $("#wrong").hidden = false;
    $("#wrong-who").textContent = (who === "ai" ? "— AI" : "— 규칙") + " · 정답 → 판정";
    $("#wrong-list").innerHTML = s.wrong.slice(0, 15).map(w => {
      const diff = ["category", "sentiment", "urgency"].filter(k => w.got[k] !== w.want[k])
        .map(k => `${w.want[k]}→${w.got[k]}`).join(" · ");
      return `<li><span class="t">${w.text}</span><br><span class="d">${diff}${w.note ? " · " + w.note : ""}</span></li>`;
    }).join("") + (s.wrong.length > 15 ? `<li class="d">… 외 ${s.wrong.length - 15}건</li>` : "");
  }

  $("#btn-score-rule").addEventListener("click", () => {
    const s = Rules.score(S.test, r => Rules.classify(Mask.mask(r.text).masked, S.criteria));
    showScore("rule", s);
    $("#score-msg").hidden = true;
  });

  $("#btn-score-ai").addEventListener("click", async () => {
    const btn = $("#btn-score-ai");
    btn.disabled = true;
    const masked = S.test.map(r => Mask.mask(r.text).masked);
    const results = [];
    const model = currentModel();   // 채점 도중 드롭다운을 바꿔도 이번 채점은 한 모델로 끝낸다
    const used = [];                // 서버가 실제로 쓴 모델 이름
    for (let i = 0; i < masked.length; i += BATCH) {
      const batch = masked.slice(i, i + BATCH);
      btn.textContent = `AI 채점 중… ${i}/${masked.length}`;
      let r = await askAI(batch, model);
      if (r.timeout) {              // 느리면 그 묶음만 한 번 더 시도한다
        btn.textContent = `AI 채점 중… ${i}/${masked.length} · 다시 시도`;
        r = await askAI(batch, model);
      }
      if (!r.results) {
        $("#score-msg").hidden = false;
        $("#score-msg").textContent = `AI로 채점하지 못했습니다 — ${r.reason}${r.timeout ? " (두 번 시도했습니다)" : ""}`;
        btn.disabled = false; btn.textContent = "AI로 채점";
        return;
      }
      if (r.model && !used.includes(r.model)) used.push(r.model);
      results.push(...r.results);
    }
    // 답을 못 받은 문장은 «오답»으로 센다 — 빠진 것을 빼고 세면 점수가 부풀려진다
    const miss = { category: "-", sentiment: "-", urgency: "-" };
    S.aiResults = results;
    const s = Rules.score(S.test, (r, i) => results[i] || miss);
    showScore("ai", s);
    $("#th-ai").textContent = used.length ? "AI · " + used.join(", ") : "AI";
    const blank = results.filter(x => !x).length;
    $("#score-msg").hidden = !blank;
    if (blank) $("#score-msg").textContent = `AI가 답하지 않은 문장 ${blank}건은 오답으로 셌습니다.`;
    $("#btn-download").hidden = false;
    btn.disabled = false; btn.textContent = "AI로 채점";
  });

  $("#btn-download").addEventListener("click", () => {
    const rows = S.test.map((r, i) => ({ id: r.id, text: r.text, 정답: r, AI: S.aiResults[i] }));
    const blob = new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ai_채점결과.json"; a.click();
  });

  // ── 기준 ───────────────────────────────────────────
  function renderCriteria() {
    const c = S.criteria;
    $("#owner").textContent = c.owner;
    $("#crit-cats").innerHTML = c.categories
      .map(x => `<tr><td>${x.name}</td><td>${x.definition}</td></tr>`).join("");
    $("#crit-priority").textContent = c.priority.join(" → ") + " 순서로 먼저 봅니다.";
    $("#crit-priority-reason").textContent = c.priority_reason;
    $("#crit-sent").textContent = c.sentiment.guide;
    $("#crit-urg").textContent = c.urgency.guide;
  }

  load();
  loadServerDefault();
})();

