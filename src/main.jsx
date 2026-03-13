import React from 'react'
import ReactDOM from 'react-dom/client'
import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ─── Constants ────────────────────────────────────────────────────────────────
const JOURNALS = "Lancet · BMJ · NEJM · JAMA · AAC · JAC · CID · JMM · A&R · IDSA";

const CAT_CONFIG = {
  anti:   { label: "抗菌药物", emoji: "🦠", color: "#c8442f", bg: "#fff0ee", border: "#f0c0b8", activeBg: "#c8442f" },
  endo:   { label: "内分泌",   emoji: "⚗️", color: "#3a8a3a", bg: "#f0f8ee", border: "#b8d8b8", activeBg: "#3a8a3a" },
  cardio: { label: "高血压/高脂血症", emoji: "❤️", color: "#4040c8", bg: "#eef0ff", border: "#b8b8f0", activeBg: "#4040c8" },
  meta:   { label: "肥胖代谢", emoji: "⚖️", color: "#b87a00", bg: "#fff8e8", border: "#e8d080", activeBg: "#b87a00" },
};

const ENDO_SUBS = [
  { id: "diabetes",     label: "糖尿病",    emoji: "🩸", keywords: "insulin, GLP-1 receptor agonist, SGLT-2 inhibitor, metformin, HbA1c, type 2 diabetes, hypoglycemia, CGM" },
  { id: "thyroid",      label: "甲状腺",    emoji: "🦋", keywords: "hypothyroidism, hyperthyroidism, thyroid cancer, levothyroxine, antithyroid drugs, TSH, radioiodine" },
  { id: "adrenal",      label: "肾上腺",    emoji: "💊", keywords: "adrenal insufficiency, Cushing syndrome, primary aldosteronism, hydrocortisone, fludrocortisone, adrenal crisis" },
  { id: "gonad",        label: "性腺",      emoji: "🔬", keywords: "hypogonadism, PCOS, testosterone, estrogen, fertility, menopause, hormone replacement therapy" },
  { id: "parathyroid",  label: "甲状旁腺",  emoji: "🫀", keywords: "hyperparathyroidism, PTH, calcium disorders, cinacalcet, parathyroidectomy, hypoparathyroidism" },
  { id: "electrolyte",  label: "电解质紊乱",emoji: "⚡", keywords: "hyponatremia, hyperkalemia, hypokalemia, tolvaptan, potassium binders, patiromer, sodium zirconium" },
  { id: "osteoporosis", label: "骨质疏松",  emoji: "🦴", keywords: "bisphosphonate, denosumab, teriparatide, romosozumab, fracture prevention, RANK ligand, bone mineral density" },
];
const ENDO_SUB_MAP = Object.fromEntries(ENDO_SUBS.map(s => [s.id, s]));

// ─── JSON repair helpers ──────────────────────────────────────────────────────
function repairAndParseJSON(raw) {
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("响应中未找到 JSON 数据");
  s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch (_) {}
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\r\n/g, "\\n").replace(/\r/g, "\\n");
  try { return JSON.parse(fixUnescapedQuotes(s)); } catch (_) {}
  return extractArticlesRegex(raw);
}
function fixUnescapedQuotes(s) {
  let out = "", inStr = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (!inStr) { if (ch === '"') inStr = true; out += ch; }
    else {
      if (ch === '"') {
        let j = i + 1; while (j < s.length && s[j] === " ") j++;
        const nx = s[j];
        if (nx === ":" || nx === "," || nx === "}" || nx === "]") { inStr = false; out += ch; }
        else out += '\\"';
      } else out += ch;
    }
  }
  return out;
}
function extractArticlesRegex(raw) {
  const arrMatch = raw.match(/"articles"\s*:\s*\[([\s\S]*)\]/);
  if (!arrMatch) throw new Error("无法提取文献列表，请重试");
  const articles = []; let depth = 0, start = -1;
  const t = arrMatch[1];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "{") { if (!depth) start = i; depth++; }
    else if (t[i] === "}") { depth--; if (!depth && start !== -1) { try { const o = parseOneArticle(t.slice(start, i + 1)); if (o) articles.push(o); } catch (_) {} start = -1; } }
  }
  if (!articles.length) throw new Error("文献解析失败，请重试");
  return { articles };
}
function parseOneArticle(chunk) {
  try { return JSON.parse(chunk); } catch (_) {}
  const field = k => { const m = chunk.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)); return m ? m[1].replace(/\\n/g," ").replace(/\\"/g,'"') : ""; };
  return { id: field("id") || Math.random().toString(36).slice(2), journal: field("journal"), title: field("title"), abstract: field("abstract"), url: field("url"), date: field("date"), category: field("category") || "anti", endoSubtype: field("endoSubtype"), keyPoints: field("keyPoints") };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(activeCats, activeEndoSubs) {
  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const catLabels = {
    anti: "抗菌药物（细菌/真菌/病毒）",
    endo: `内分泌（含：${[...activeEndoSubs].map(id => ENDO_SUB_MAP[id]?.label).join("、")}）`,
    cardio: "高血压/高脂血症", meta: "肥胖代谢",
  };
  const cats = [...activeCats].map(c => catLabels[c]).join("、");
  const endoKw = activeCats.has("endo") && activeEndoSubs.size > 0
    ? "\n\n内分泌各子专科检索关键词：\n" + ENDO_SUBS.filter(s => activeEndoSubs.has(s.id)).map(s => `- ${s.label}：${s.keywords}`).join("\n") : "";
  return `你是一名专业临床药学文献助手。今天是${today}。
请为三甲医院临床药师检索以下顶级期刊中与【${cats}】药物治疗相关的最新发表文章。${endoKw}

监测期刊：
- 综合顶级：The Lancet、The BMJ、New England Journal of Medicine、JAMA
- 抗感染：Antimicrobial Agents and Chemotherapy、Journal of Antimicrobial Chemotherapy、Clinical Infectious Diseases、Journal of Medical Microbiology、Antimicrobials & Resistance
- 内分泌：Journal of Clinical Endocrinology & Metabolism、European Journal of Endocrinology、Diabetes Care、Thyroid
- 指南：IDSA guidelines

请返回 8-10 篇文章。必须以合法 JSON 格式输出，只输出 JSON，无其他文字：
{"articles":[{"id":"art1","journal":"期刊英文全称","title":"文章英文原标题","abstract":"英文摘要100-150词单行纯文本，禁止双引号，用单引号替代","url":"https://pubmed.ncbi.nlm.nih.gov/真实PMID/","date":"YYYY-MM-DD","category":"anti","endoSubtype":"","keyPoints":"中文要点2-3句，禁止双引号"}]}

规则：
1. abstract 和 keyPoints 内所有双引号替换为单引号，且不得换行
2. category 只能是：anti / endo / cardio / meta
3. endoSubtype：非endo类留空字符串；endo类填：diabetes/thyroid/adrenal/gonad/parathyroid/electrolyte/osteoporosis
4. 内分泌文章需覆盖已选全部子专科，每专科至少1篇
5. URL必须是真实PubMed或DOI链接`;
}

// ─── Excel export ─────────────────────────────────────────────────────────────
function exportToExcel(saved, notes) {
  const rows = saved.map(a => ({
    "期刊": a.journal || "",
    "标题": a.title || "",
    "分类": CAT_CONFIG[a.category]?.label || a.category || "",
    "内分泌子专科": a.endoSubtype ? (ENDO_SUB_MAP[a.endoSubtype]?.label || a.endoSubtype) : "",
    "发表日期": a.date || "",
    "中文要点": a.keyPoints || "",
    "摘要": a.abstract || "",
    "原文链接": a.url || "",
    "我的笔记": notes[a.id] || "",
    "导出日期": new Date().toLocaleDateString("zh-CN"),
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [18, 52, 12, 12, 12, 42, 60, 42, 42, 14].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "药讯收藏");
  XLSX.writeFile(wb, `MedPulse收藏_${new Date().toLocaleDateString("zh-CN").replace(/\//g,"-")}.xlsx`);
}

// ─── Note Modal ───────────────────────────────────────────────────────────────
function NoteModal({ article, note, onSave, onClose }) {
  const [text, setText] = useState(note || "");
  const ref = useRef();
  useEffect(() => { setTimeout(() => ref.current?.focus(), 80); }, []);

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, zIndex:999, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(15,13,26,0.6)", padding:16, backdropFilter:"blur(4px)", animation:"fadeIn 0.15s ease" }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#fefcf8", borderRadius:14, width:"100%", maxWidth:560, boxShadow:"0 24px 64px rgba(0,0,0,0.35)", display:"flex", flexDirection:"column", maxHeight:"92vh" }}>
        {/* Header */}
        <div style={{ padding:"18px 20px 14px", borderBottom:"1px solid #ede8dc", display:"flex", alignItems:"flex-start", gap:12 }}>
          <div style={{ width:36, height:36, background:"#fff8e0", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>📝</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:10, color:"#b8972a", fontFamily:"monospace", marginBottom:3, letterSpacing:0.5 }}>{article.journal} · {article.date}</div>
            <div style={{ fontSize:13, fontWeight:700, color:"#1a1a2e", lineHeight:1.45, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{article.title}</div>
          </div>
          <button onClick={onClose} style={{ background:"#f0ede8", border:"none", width:28, height:28, borderRadius:"50%", fontSize:14, color:"#7a7060", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>×</button>
        </div>
        {/* Body */}
        <div style={{ padding:"16px 20px", flex:1, overflowY:"auto" }}>
          <label style={{ fontSize:11, color:"#7a7060", fontWeight:600, display:"block", marginBottom:8 }}>阅读笔记 · Reading Notes</label>
          <textarea
            ref={ref} value={text} onChange={e => setText(e.target.value)}
            placeholder={"记录您的阅读心得、临床启示、用药思考……\n\n例如：\n• 该研究对我科XXX患者有参考价值\n• 需关注XXX副作用\n• 与指南XXX建议一致/不同"}
            style={{ width:"100%", minHeight:200, border:"1px solid #c8bfa8", borderRadius:8, padding:"12px 14px", fontSize:13, lineHeight:1.85, color:"#1a1a2e", background:"#fffef8", resize:"vertical", fontFamily:"inherit", outline:"none", boxSizing:"border-box", transition:"border-color 0.15s" }}
            onFocus={e => e.target.style.borderColor="#b8972a"}
            onBlur={e => e.target.style.borderColor="#c8bfa8"}
          />
          <div style={{ marginTop:6, fontSize:10, color:"#bbb", textAlign:"right" }}>{text.length} 字</div>
        </div>
        {/* Footer */}
        <div style={{ padding:"12px 20px 16px", borderTop:"1px solid #ede8dc", display:"flex", justifyContent:"flex-end", alignItems:"center", gap:8 }}>
          {note && (
            <button onClick={() => { onSave(""); onClose(); }} style={{ background:"none", border:"1px solid #f0b8b8", color:"#c8442f", borderRadius:7, padding:"8px 14px", fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
              🗑 删除
            </button>
          )}
          <button onClick={onClose} style={{ background:"none", border:"1px solid #c8bfa8", color:"#7a7060", borderRadius:7, padding:"8px 16px", fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
            取消
          </button>
          <button onClick={() => { onSave(text); onClose(); }} style={{ background:"#1a1a2e", border:"none", color:"#f5f0e8", borderRadius:7, padding:"8px 22px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600 }}>
            💾 保存笔记
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Skeleton Card ────────────────────────────────────────────────────────────
function SkeletonCard() {
  const L = (w, h=12, mt=0) => ({ width:w, height:h, marginTop:mt, marginBottom:8, background:"linear-gradient(90deg,#ede8dc 25%,#f5f0e8 50%,#ede8dc 75%)", backgroundSize:"200% 100%", borderRadius:4, animation:"shimmer 1.4s infinite" });
  return (
    <div style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:10, padding:18 }}>
      <div style={L("30%",11)} /><div style={L("88%",15,8)} /><div style={L("70%",15)} /><div style={L("100%",11,8)} /><div style={L("93%",11)} /><div style={L("80%",11)} />
    </div>
  );
}

// ─── Article Card ─────────────────────────────────────────────────────────────
function ArticleCard({ article: a, delay, isExpanded, isSaved, note, onExpand, onSave, onNote, isMobile }) {
  const endoSub = a.endoSubtype ? ENDO_SUB_MAP[a.endoSubtype] : null;
  const cfg = CAT_CONFIG[a.category] || CAT_CONFIG.anti;
  const barClr = { anti:"#c8442f", endo:"#3a8a3a", cardio:"#4040c8", meta:"#b87a00" }[a.category] || "#c8442f";

  return (
    <div className="med-card" style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:10, overflow:"hidden", animation:`slideIn 0.35s ease ${delay}ms both` }}>
      <div style={{ height:3, background:barClr }} />
      <div style={{ padding: isMobile ? "13px 14px" : "16px 18px" }}>
        {/* Meta */}
        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8, flexWrap:"wrap" }}>
          <span style={{ fontFamily:"monospace", fontSize:9, fontWeight:600, padding:"2px 7px", borderRadius:3, background:"#1a1a2e", color:"#b8972a", letterSpacing:0.3, maxWidth:isMobile?120:220, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flexShrink:0 }}>{a.journal}</span>
          <span style={{ fontSize:9, padding:"2px 7px", borderRadius:10, fontWeight:600, background:cfg.bg, color:cfg.color, border:`1px solid ${cfg.border}`, flexShrink:0 }}>{cfg.label}</span>
          {endoSub && <span style={{ fontSize:9, background:"#e8f5e8", color:"#2a6a2a", borderRadius:10, padding:"2px 7px", border:"1px solid #b0d8b0", fontWeight:500 }}>{endoSub.emoji} {endoSub.label}</span>}
          {note && <span style={{ fontSize:9, background:"#fff8e0", color:"#b87a00", borderRadius:10, padding:"2px 6px", border:"1px solid #e8d080", fontWeight:500 }}>📝 有笔记</span>}
          {a.date && <span style={{ fontSize:9, color:"#aaa", marginLeft:"auto", fontFamily:"monospace", flexShrink:0 }}>{a.date}</span>}
        </div>
        {/* Title */}
        <div style={{ fontFamily:"Georgia,'Times New Roman',serif", fontSize:isMobile?13:14, fontWeight:700, color:"#1a1a2e", lineHeight:1.55, marginBottom:8 }}>{a.title}</div>
        {/* Key points */}
        {a.keyPoints && <div style={{ fontSize:12, color:"#1e6b6b", background:"#d0eae8", padding:"8px 11px", borderRadius:5, marginBottom:8, lineHeight:1.7 }}>💡 {a.keyPoints}</div>}
        {/* Abstract */}
        <div style={{ fontSize:12, color:"#444", lineHeight:1.85, marginBottom:10, display:"-webkit-box", WebkitLineClamp:isExpanded?999:4, WebkitBoxOrient:"vertical", overflow:isExpanded?"visible":"hidden" }}>{a.abstract}</div>
        {/* Note preview (inline, when expanded) */}
        {note && isExpanded && (
          <div style={{ marginBottom:10, padding:"10px 12px", background:"#fffbea", border:"1px solid #e8d880", borderRadius:7, fontSize:12, color:"#5a4800", lineHeight:1.8 }}>
            <div style={{ fontSize:10, fontWeight:700, color:"#b87a00", marginBottom:4 }}>📝 我的笔记</div>
            <div style={{ whiteSpace:"pre-wrap" }}>{note}</div>
          </div>
        )}
        {/* Footer */}
        <div style={{ display:"flex", alignItems:"center", gap:isMobile?5:8, paddingTop:10, borderTop:"1px solid #ede8dc", flexWrap:"wrap" }}>
          <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:"#1e6b6b", textDecoration:"none", fontWeight:500, flexShrink:0 }}>🔗 原文</a>
          <button onClick={onExpand} style={{ fontSize:11, color:"#7a7060", background:"none", border:"none", cursor:"pointer", padding:0, fontFamily:"inherit" }}>
            {isExpanded?"收起 ▴":"展开 ▾"}
          </button>
          <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
            <button onClick={onNote} title="笔记" style={{ background:note?"#fff8e0":"none", border:`1px solid ${note?"#ddc040":"#c8bfa8"}`, padding:isMobile?"6px 8px":"5px 12px", borderRadius:6, fontSize:11, color:note?"#b87a00":"#7a7060", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:4, transition:"all 0.15s", whiteSpace:"nowrap" }}>
              📝{!isMobile && <span>{note?"编辑笔记":"笔记"}</span>}
            </button>
            <button onClick={onSave} title={isSaved?"取消收藏":"收藏"} style={{ background:isSaved?"#f5e8b0":"none", border:`1px solid ${isSaved?"#c8a820":"#c8bfa8"}`, padding:isMobile?"6px 8px":"5px 12px", borderRadius:6, fontSize:11, color:isSaved?"#996800":"#7a7060", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:4, transition:"all 0.15s", whiteSpace:"nowrap" }}>
              {isSaved?"⭐":"☆"}{!isMobile && <span>{isSaved?"已收藏":"收藏"}</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Source Card ──────────────────────────────────────────────────────────────
function SourceCard({ title, items, color }) {
  return (
    <div style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:8, overflow:"hidden", marginBottom:0 }}>
      <div style={{ padding:"10px 14px", background:"#1a1a2e", color:"#f5f0e8", fontSize:11, fontWeight:600, letterSpacing:0.8 }}>{title}</div>
      <div style={{ padding:"10px 14px" }}>
        {items.map(item => (
          <div key={item} style={{ fontSize:10, color:"#7a7060", padding:"4px 0", borderBottom:"1px solid #ede8dc", display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ width:5,height:5,borderRadius:"50%",background:color,flexShrink:0 }} />{item}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function MedPulse() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 680);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 680);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);

  const [tab, setTab] = useState("feed");
  const [activeCats, setActiveCats] = useState(new Set(["anti","endo","cardio","meta"]));
  const [activeEndoSubs, setActiveEndoSubs] = useState(new Set(ENDO_SUBS.map(s => s.id)));
  const [endoOpen, setEndoOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [articles, setArticles] = useState([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});
  const [saved, setSaved] = useState(() => { try { return JSON.parse(localStorage.getItem("mp_saved_v3") || "[]"); } catch { return []; } });
  const [notes, setNotes] = useState(() => { try { return JSON.parse(localStorage.getItem("mp_notes_v3") || "{}"); } catch { return {}; } });
  const [noteModal, setNoteModal] = useState(null);

  const dateStr = new Date().toLocaleDateString("zh-CN", { year:"numeric", month:"long", day:"numeric", weekday:"long" });

  useEffect(() => { try { localStorage.setItem("mp_saved_v3", JSON.stringify(saved)); } catch {} }, [saved]);
  useEffect(() => { try { localStorage.setItem("mp_notes_v3", JSON.stringify(notes)); } catch {} }, [notes]);

  const toggleCat = cat => {
    setActiveCats(p => { const n=new Set(p); n.has(cat)?(n.size>1&&n.delete(cat)):n.add(cat); return n; });
    if (cat==="endo") setEndoOpen(false);
  };
  const toggleSub = id => setActiveEndoSubs(p => { const n=new Set(p); n.has(id)?(n.size>1&&n.delete(id)):n.add(id); return n; });
  const toggleSave = a => setSaved(p => { const i=p.findIndex(x=>x.id===a.id); if(i>=0){const n=[...p];n.splice(i,1);return n;} return [...p,a]; });
  const isSaved = id => saved.some(a=>a.id===id);
  const saveNote = (id, text) => setNotes(p => { if(!text){const n={...p};delete n[id];return n;} return {...p,[id]:text}; });
  const toggleExpand = key => setExpanded(p => ({...p,[key]:!p[key]}));

  const fetchArticles = useCallback(async () => {
    if (loading) return;
    setLoading(true); setError(""); setArticles([]); setProgress(10); setStatus("正在连接检索引擎…");
    try {
      setProgress(28); setStatus("正在检索顶级期刊最新文献…");
      const res = await fetch("/api/chat", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:4000,
          tools:[{type:"web_search_20250305",name:"web_search"}],
          messages:[{role:"user",content:buildPrompt(activeCats,activeEndoSubs)}] }),
      });
      setProgress(65); setStatus("正在分析文献数据…");
      if (!res.ok) { const e=await res.json(); throw new Error(e.error?.message||`API错误 ${res.status}`); }
      const data = await res.json();
      setProgress(82); setStatus("正在解析 JSON…");
      const txt = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");
      const parsed = repairAndParseJSON(txt);
      const list = (parsed.articles||[]).filter(a => activeCats.has(a.category) && (a.category!=="endo"||!a.endoSubtype||activeEndoSubs.has(a.endoSubtype)));
      setProgress(100); setStatus(`✓ 已获取 ${list.length} 篇相关文献`);
      setArticles(list);
    } catch(e) {
      setError("检索失败：" + e.message); setStatus("");
    } finally {
      setLoading(false); setTimeout(()=>setProgress(0),2500);
    }
  }, [activeCats, activeEndoSubs, loading]);

  const TABS = [["feed","📡","今日推送"],["saved","🔖","我的收藏"],["sources","📚","期刊来源"]];

  const renderCard = (a, i, pfx) => (
    <ArticleCard key={pfx+a.id} article={a} delay={i*55} isMobile={isMobile}
      isExpanded={!!expanded[pfx+a.id]} isSaved={isSaved(a.id)} note={notes[a.id]}
      onExpand={() => toggleExpand(pfx+a.id)}
      onSave={() => toggleSave(a)}
      onNote={() => setNoteModal(a)}
    />
  );

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif", background:"linear-gradient(150deg,#f5f0e8 0%,#ede8dc 100%)", minHeight:"100vh", color:"#1a1a2e" }}>
      <style>{`
        *{box-sizing:border-box}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        @keyframes slideIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        .med-card{transition:box-shadow 0.2s,transform 0.2s}
        .med-card:hover{box-shadow:0 6px 24px rgba(0,0,0,0.12)!important;transform:translateY(-2px)!important}
        textarea:focus{border-color:#b8972a!important;outline:none}
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:#f0ece0} ::-webkit-scrollbar-thumb{background:#c8bfa8;border-radius:3px}
      `}</style>

      {/* ── HEADER ─────────────────────────────────────────── */}
      <header style={{ background:"#1a1a2e", position:"sticky", top:0, zIndex:200, boxShadow:"0 2px 16px rgba(0,0,0,0.4)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:isMobile?"11px 16px":"13px 28px", borderBottom:"1px solid rgba(200,180,150,0.18)" }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
            <span style={{ fontFamily:"Georgia,serif", fontSize:isMobile?20:24, fontWeight:700, color:"#f5f0e8" }}>MedPulse</span>
            <span style={{ fontSize:isMobile?10:12, color:"#b8972a", letterSpacing:2, fontWeight:600 }}>药讯日报</span>
          </div>
          <span style={{ fontSize:10, color:"rgba(245,240,232,0.38)", fontFamily:"monospace" }}>
            {isMobile ? new Date().toLocaleDateString("zh-CN",{month:"short",day:"numeric",weekday:"short"}) : dateStr}
          </span>
        </div>
        {/* Desktop nav */}
        {!isMobile && (
          <div style={{ display:"flex", padding:"0 28px" }}>
            {TABS.map(([id,,label]) => (
              <div key={id} onClick={() => setTab(id)} style={{ padding:"9px 20px", fontSize:12, fontWeight:500, color:tab===id?"#b8972a":"rgba(245,240,232,0.5)", cursor:"pointer", borderBottom:tab===id?"2px solid #b8972a":"2px solid transparent", transition:"all 0.2s", userSelect:"none" }}>
                {label}
              </div>
            ))}
          </div>
        )}
      </header>

      {/* ── BODY ──────────────────────────────────────────── */}
      <div style={{ maxWidth:1060, margin:"0 auto", padding:isMobile?"14px 12px 84px":"28px 24px", display:"grid", gridTemplateColumns:isMobile?"1fr":"1fr 265px", gap:isMobile?14:28 }}>
        <main>

          {/* ══════ FEED TAB ══════ */}
          {tab==="feed" && (
            <>
              {/* Fetch panel */}
              <div style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:10, padding:isMobile?"14px":"18px 22px", marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#1a1a2e", marginBottom:10 }}>文献检索范围</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8, alignItems:"center" }}>
                  {Object.entries(CAT_CONFIG).map(([cat,cfg]) => (
                    <span key={cat} style={{ display:"inline-flex", alignItems:"center", gap:3 }}>
                      <span onClick={() => toggleCat(cat)} style={{ display:"inline-block", padding:"5px 12px", borderRadius:20, fontSize:isMobile?11:12, fontWeight:500, cursor:"pointer", border:`1px solid ${activeCats.has(cat)?cfg.activeBg:cfg.border}`, background:activeCats.has(cat)?cfg.activeBg:cfg.bg, color:activeCats.has(cat)?"#fff":cfg.color, userSelect:"none", transition:"all 0.15s" }}>
                        {cfg.emoji} {cfg.label}
                      </span>
                      {cat==="endo" && activeCats.has("endo") && (
                        <button onClick={() => setEndoOpen(o=>!o)} style={{ fontSize:10, color:"#3a8a3a", background:"none", border:"none", cursor:"pointer", textDecoration:"underline", padding:"0 2px", fontFamily:"inherit" }}>
                          {endoOpen?"▴":"▾"}子专科
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {endoOpen && activeCats.has("endo") && (
                  <div style={{ background:"#f0faf0", border:"1px solid #b8d8b8", borderRadius:7, padding:"10px 12px", marginBottom:10 }}>
                    <div style={{ fontSize:9, color:"#3a8a3a", fontWeight:700, letterSpacing:1, marginBottom:7, textTransform:"uppercase" }}>内分泌子专科（点击选择）</div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                      {ENDO_SUBS.map(s => (
                        <span key={s.id} onClick={() => toggleSub(s.id)} style={{ padding:"4px 10px", borderRadius:20, fontSize:isMobile?10:11, fontWeight:500, cursor:"pointer", border:`1px solid ${activeEndoSubs.has(s.id)?"#2a6a2a":"#a8cca8"}`, background:activeEndoSubs.has(s.id)?"#2a6a2a":"#e8f5e8", color:activeEndoSubs.has(s.id)?"#fff":"#2a6a2a", userSelect:"none", transition:"all 0.15s" }}>
                          {s.emoji} {s.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, flexWrap:"wrap", marginTop:8 }}>
                  <div style={{ fontSize:10, color:"#9a8f80", lineHeight:1.6, flex:1, minWidth:120 }}>{JOURNALS}</div>
                  <button onClick={fetchArticles} disabled={loading} style={{ background:loading?"#bbb":"#c8442f", color:"#fff", border:"none", padding:isMobile?"10px 16px":"10px 22px", borderRadius:8, fontSize:13, fontWeight:600, cursor:loading?"not-allowed":"pointer", display:"flex", alignItems:"center", gap:8, fontFamily:"inherit", flexShrink:0, transition:"background 0.2s" }}>
                    {loading && <div style={{ width:13,height:13,border:"2px solid rgba(255,255,255,0.35)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.8s linear infinite" }} />}
                    {loading?"检索中…":articles.length?"刷新药讯":"获取今日药讯"}
                  </button>
                </div>
              </div>

              {error && <div style={{ background:"#fff0ee", border:"1px solid #f0b8b0", borderRadius:7, padding:"12px 16px", fontSize:12, color:"#c8442f", marginBottom:14, lineHeight:1.6 }}>{error}</div>}

              {(loading||progress>0) && (
                <>
                  <div style={{ height:2, background:"#ede8dc", borderRadius:1, marginBottom:10, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${progress}%`, background:"linear-gradient(90deg,#c8442f,#b8972a)", transition:"width 0.4s ease" }} />
                  </div>
                  <div style={{ fontSize:11, color:"#7a7060", marginBottom:12, fontFamily:"monospace", display:"flex", alignItems:"center", gap:6 }}>
                    {loading && <div style={{ width:6,height:6,borderRadius:"50%",background:"#c8442f",animation:"spin 1s linear infinite" }} />}
                    {status}
                  </div>
                </>
              )}

              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {loading && [1,2,3,4].map(i=><SkeletonCard key={i}/>)}
                {!loading && !articles.length && !error && (
                  <div style={{ textAlign:"center", padding:"52px 20px", color:"#7a7060" }}>
                    <div style={{ fontSize:48, marginBottom:14 }}>🔬</div>
                    <div style={{ fontFamily:"Georgia,serif", fontSize:17, color:"#1a1a2e", marginBottom:8 }}>欢迎使用药讯日报</div>
                    <div style={{ fontSize:12, lineHeight:1.9, color:"#9a9080" }}>选择关注的药学领域<br/>点击「获取今日药讯」开始</div>
                  </div>
                )}
                {!loading && articles.map((a,i)=>renderCard(a,i,"f_"))}
              </div>
            </>
          )}

          {/* ══════ SAVED TAB ══════ */}
          {tab==="saved" && (
            <>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, flexWrap:"wrap" }}>
                <span style={{ fontFamily:"Georgia,serif", fontSize:15, fontWeight:700 }}>🔖 我的收藏夹</span>
                <span style={{ flex:1, height:1, background:"#c8bfa8", minWidth:20 }} />
                <span style={{ fontSize:11, color:"#7a7060" }}>{saved.length} 篇 · {Object.keys(notes).length} 篇有笔记</span>
                {saved.length>0 && (
                  <button onClick={() => exportToExcel(saved,notes)} style={{ background:"#1e6b6b", color:"#fff", border:"none", padding:"7px 14px", borderRadius:7, fontSize:11, cursor:"pointer", fontFamily:"inherit", fontWeight:600, display:"flex", alignItems:"center", gap:5 }}>
                    📊 导出 Excel
                  </button>
                )}
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {!saved.length ? (
                  <div style={{ textAlign:"center", padding:"52px 20px", color:"#7a7060" }}>
                    <div style={{ fontSize:48, marginBottom:14 }}>📂</div>
                    <div style={{ fontFamily:"Georgia,serif", fontSize:17, color:"#1a1a2e", marginBottom:8 }}>收藏夹为空</div>
                    <div style={{ fontSize:12, lineHeight:1.9 }}>在今日推送中点击「☆ 收藏」保存文献</div>
                  </div>
                ) : saved.map((a,i)=>renderCard(a,i,"s_"))}
              </div>
            </>
          )}

          {/* ══════ SOURCES TAB ══════ */}
          {tab==="sources" && (
            <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"1fr 1fr", gap:14 }}>
              <SourceCard title="🦠 抗感染领域" color="#c8442f" items={["Antimicrobial Agents and Chemotherapy","Journal of Antimicrobial Chemotherapy","Clinical Infectious Diseases","Journal of Medical Microbiology","Antimicrobials & Resistance","IDSA 指南更新"]} />
              <div>
                <SourceCard title="⚗️ 内分泌代谢" color="#3a8a3a" items={["Journal of Clinical Endocrinology & Metabolism","European Journal of Endocrinology","Diabetes Care","Thyroid","Endocrine Society 指南","ESE 指南"]} />
                <div style={{ marginTop:10, padding:"10px 14px", background:"#f4fbf4", border:"1px solid #c0dcc0", borderRadius:6 }}>
                  <div style={{ fontSize:9, color:"#3a8a3a", fontWeight:700, letterSpacing:1, marginBottom:6 }}>覆盖子专科</div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                    {ENDO_SUBS.map(s=><span key={s.id} style={{ fontSize:9, background:"#e8f5e8", color:"#2a6a2a", borderRadius:10, padding:"2px 7px", border:"1px solid #b0d8b0", fontWeight:500 }}>{s.emoji} {s.label}</span>)}
                  </div>
                </div>
              </div>
              <SourceCard title="📰 综合顶级期刊" color="#4040c8" items={["The Lancet","New England Journal of Medicine","JAMA","The BMJ"]} />
              <div style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:8, overflow:"hidden" }}>
                <div style={{ padding:"10px 14px", background:"#1a1a2e", color:"#f5f0e8", fontSize:11, fontWeight:600, letterSpacing:0.8 }}>🔍 检索策略</div>
                <div style={{ padding:"12px 14px" }}>
                  <p style={{ fontSize:11, color:"#7a7060", lineHeight:1.9, margin:0 }}>通过 Claude AI + Web 搜索，每日实时汇总上述期刊中涉及<strong> 抗细菌、抗真菌、抗病毒</strong>，以及<strong> 糖尿病、甲状腺、肾上腺、性腺、甲状旁腺、电解质紊乱、骨质疏松、高血压、高脂血症、肥胖代谢</strong>相关的最新药物治疗研究与指南更新。</p>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* ── SIDEBAR (desktop) ─────────────────────────────── */}
        {!isMobile && (
          <aside>
            <div style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:8, overflow:"hidden", marginBottom:14 }}>
              <div style={{ padding:"10px 14px", background:"#1a1a2e", color:"#f5f0e8", fontSize:11, fontWeight:600, letterSpacing:0.8 }}>📊 今日统计</div>
              <div style={{ padding:"12px 14px" }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
                  {[[articles.length||"—","今日文献"],[saved.length,"已收藏"],[Object.keys(notes).length,"笔记数"],[4,"药学分类"]].map(([n,l])=>(
                    <div key={l} style={{ background:"#ede8dc", borderRadius:6, padding:"9px 8px", textAlign:"center" }}>
                      <div style={{ fontFamily:"Georgia,serif", fontSize:22, fontWeight:700, color:"#1a1a2e", lineHeight:1 }}>{n}</div>
                      <div style={{ fontSize:9, color:"#7a7060", marginTop:2 }}>{l}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {saved.length>0 && (
              <button onClick={() => exportToExcel(saved,notes)} style={{ width:"100%", background:"#1e6b6b", color:"#fff", border:"none", padding:"10px", borderRadius:7, fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:6, marginBottom:14 }}>
                📊 导出收藏为 Excel
              </button>
            )}

            <div style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:8, overflow:"hidden", marginBottom:14 }}>
              <div style={{ padding:"10px 14px", background:"#1a1a2e", color:"#f5f0e8", fontSize:11, fontWeight:600, letterSpacing:0.8 }}>🔖 最近收藏</div>
              <div style={{ padding:"10px 14px" }}>
                {!saved.length ? <div style={{ fontSize:11, color:"#7a7060", textAlign:"center", padding:"10px 0" }}>暂无收藏</div>
                : saved.slice(-5).reverse().map(a=>(
                  <div key={a.id} onClick={()=>setTab("saved")} style={{ padding:"7px 0", borderBottom:"1px solid #ede8dc", cursor:"pointer" }}>
                    <div style={{ fontSize:9, fontFamily:"monospace", color:"#b8972a", marginBottom:2 }}>{a.journal}</div>
                    <div style={{ fontSize:11, color:"#1a1a2e", lineHeight:1.4, fontWeight:500 }}>{a.title.slice(0,52)}{a.title.length>52?"…":""}</div>
                    {notes[a.id] && <div style={{ fontSize:9, color:"#b87a00", marginTop:2 }}>📝 有笔记</div>}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background:"#fefcf8", border:"1px solid #c8bfa8", borderRadius:8, overflow:"hidden" }}>
              <div style={{ padding:"10px 14px", background:"#1a1a2e", color:"#f5f0e8", fontSize:11, fontWeight:600, letterSpacing:0.8 }}>📋 监测期刊</div>
              <div style={{ padding:"10px 14px" }}>
                {[["#c8442f","Lancet/NEJM/BMJ/JAMA"],["#c8442f","AAC · JAC · CID · JMM"],["#c8442f","Antimicrobials & Resistance"],["#3a8a3a","内分泌协会（US/EU）"],["#4040c8","IDSA 指南"]].map(([c,t])=>(
                  <div key={t} style={{ fontSize:10, color:"#7a7060", padding:"4px 0", borderBottom:"1px solid #ede8dc", display:"flex", alignItems:"center", gap:5 }}>
                    <span style={{ width:5,height:5,borderRadius:"50%",background:c,flexShrink:0 }} />{t}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* ── MOBILE BOTTOM NAV ─────────────────────────────── */}
      {isMobile && (
        <nav style={{ position:"fixed", bottom:0, left:0, right:0, background:"#1a1a2e", display:"flex", zIndex:200, boxShadow:"0 -2px 16px rgba(0,0,0,0.4)", paddingBottom:"env(safe-area-inset-bottom,0px)" }}>
          {TABS.map(([id,emoji,label]) => (
            <div key={id} onClick={()=>setTab(id)} style={{ flex:1, padding:"10px 0 8px", textAlign:"center", cursor:"pointer", borderTop:`2px solid ${tab===id?"#b8972a":"transparent"}`, userSelect:"none" }}>
              <div style={{ fontSize:22, lineHeight:1 }}>{emoji}</div>
              <div style={{ fontSize:10, color:tab===id?"#b8972a":"rgba(245,240,232,0.45)", marginTop:3, fontWeight:tab===id?600:400 }}>{label}</div>
            </div>
          ))}
        </nav>
      )}

      {/* ── NOTE MODAL ─────────────────────────────────────── */}
      {noteModal && (
        <NoteModal article={noteModal} note={notes[noteModal.id]||""} onSave={text=>saveNote(noteModal.id,text)} onClose={()=>setNoteModal(null)} />
      )}
    </div>
  );
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <MedPulse />
  </React.StrictMode>
);
