import { ArrowDown, ArrowDownAZ, ArrowUp, ArrowUpAZ, ArrowUpDown, LoaderCircle, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { hasLongContextPricing, samePrices, sortPricingRows, type PricingSort, type PricingSortKey } from "../lib/pricing";
import type { PricingRule } from "../types";

type PriceField = "inputUsdPerMillion" | "cachedUsdPerMillion" | "cacheWriteUsdPerMillion" | "outputUsdPerMillion" | "priorityMultiplier";
const fields: Array<{ field: PriceField; label: string; accessible: string; unavailable?: string }> = [
  { field: "inputUsdPerMillion", label: "輸入 Input", accessible: "input 價格" },
  { field: "cachedUsdPerMillion", label: "快取輸入 Cached input", accessible: "cached input 價格", unavailable: "cached" },
  { field: "outputUsdPerMillion", label: "輸出 Output", accessible: "output 價格" },
  { field: "cacheWriteUsdPerMillion", label: "快取寫入 Cache writes", accessible: "cache writes 價格", unavailable: "cacheWrite" },
  { field: "priorityMultiplier", label: "Fast / Priority 倍率", accessible: "Priority 倍率", unavailable: "fast" }
];
type ContextField = "longContextThreshold" | "longInputMultiplier" | "longOutputMultiplier";
const contextFields: Array<{ field: ContextField; label: string; accessible: string }> = [
  { field: "longContextThreshold", label: "輸入門檻（Tokens）", accessible: "長 context 門檻" },
  { field: "longInputMultiplier", label: "輸入與快取倍率", accessible: "長 context 輸入倍率" },
  { field: "longOutputMultiplier", label: "輸出倍率", accessible: "長 context 輸出倍率" }
];
const columns: Array<{ key: PricingSortKey; label: string; english?: string; accessible: string }> = [
  { key: "model", label: "模型名稱", accessible: "模型名稱排序" },
  { key: "inputUsdPerMillion", label: "輸入", english: "Input", accessible: "輸入價格排序" },
  { key: "cachedUsdPerMillion", label: "快取輸入", english: "Cached input", accessible: "快取輸入價格排序" },
  { key: "outputUsdPerMillion", label: "輸出", english: "Output", accessible: "輸出價格排序" }
];
const keyOf = (model: string) => model.trim().toLowerCase();
const price = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const thresholdLabel = (value: number) => value % 1000 === 0 ? `${price(value / 1000)}K` : price(value);
const newRule = (model: string): PricingRule => ({ model, inputUsdPerMillion: 0, cachedUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 0, cacheWriteMultiplier: 1.25, longContextThreshold: Number.MAX_SAFE_INTEGER, longInputMultiplier: 1, longOutputMultiplier: 1, priorityMultiplier: 2, sourceUrl: "", reviewedAt: new Date().toISOString().slice(0, 10) });
const valuesOf = (rule: PricingRule | null) => Object.fromEntries(fields.map(({ field, unavailable }) => [field, !rule || unavailable && rule.unavailableRates?.includes(unavailable) ? "" : String(rule[field])])) as Record<PriceField, string>;
const contextValuesOf = (rule: PricingRule | null) => ({
  longContextThreshold: rule && rule.longContextThreshold < Number.MAX_SAFE_INTEGER ? String(rule.longContextThreshold) : "",
  longInputMultiplier: String(rule?.longInputMultiplier ?? 2),
  longOutputMultiplier: String(rule?.longOutputMultiplier ?? 1.5)
});

type Commit = (rule: PricingRule | null, original: PricingRule | null) => Promise<void>;
interface Props {
  rules: PricingRule[];
  officialRules: PricingRule[];
  usedModels: string[];
  busy: boolean;
  onSave: Commit;
}

export function PricingEditor({ rules, officialRules, usedModels, busy, onSave }: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PricingSort>({ key: "model", direction: "ascending" });
  const [editing, setEditing] = useState<{ model: string; original: PricingRule | null } | null>(null);
  const [message, setMessage] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const used = new Set(usedModels.map(keyOf));
  const official = new Map(officialRules.map(rule => [keyOf(rule.model), rule]));
  const rows = new Map(rules.map(rule => [keyOf(rule.model), { model: rule.model, rule: rule as PricingRule | null }]));
  for (const model of usedModels) if (!rows.has(keyOf(model))) rows.set(keyOf(model), { model, rule: null });
  const visible = sortPricingRows([...rows.values()].filter(row => keyOf(row.model).includes(keyOf(search))), sort);
  const sortBy = (key: PricingSortKey) => setSort(current => ({ key, direction: current.key === key && current.direction === "ascending" ? "descending" : "ascending" }));
  const open = (model: string, original: PricingRule | null) => {
    opener.current = document.activeElement as HTMLElement;
    setMessage(""); setEditing({ model, original });
  };
  const dismiss = () => {
    setEditing(null);
    requestAnimationFrame(() => (opener.current?.isConnected ? opener.current : searchRef.current)?.focus());
  };
  const commit: Commit = async (rule, original) => {
    await onSave(rule, original);
    setMessage(rule ? `${rule.model} 的價格已保存。` : `${original?.model} 的自訂價格已移除。`);
    dismiss();
  };

  return <div className="pricing-browser">
    <div className="pricing-toolbar">
      <label className="pricing-search"><Search size={17} aria-hidden="true" /><input ref={searchRef} type="search" aria-label="搜尋模型價格" placeholder="搜尋全部模型…" value={search} onChange={event => setSearch(event.target.value)} />{search ? <button type="button" aria-label="清除模型搜尋" onClick={() => { setSearch(""); searchRef.current?.focus(); }}><X size={15} /></button> : null}</label>
      <span className="pricing-count">{search ? `${visible.length} / ${rows.size}` : rows.size} 個模型</span>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => open("", null)}><Plus size={16} aria-hidden="true" />新增自訂價格</button>
    </div>
    {message ? <p className="pricing-saved" role="status">{message}</p> : null}
    <p className="pricing-rate-hint">下列為一般單價；超過輸入門檻時，依模型的長 context 規則加價。</p>
    <table className="pricing-table" aria-label="模型 API 等值價格">
      <thead><tr>{columns.map(({ key, label, english, accessible }) => {
        const active = sort.key === key;
        const ascending = sort.direction === "ascending";
        const Icon = !active ? ArrowUpDown : key === "model" ? ascending ? ArrowDownAZ : ArrowUpAZ : ascending ? ArrowUp : ArrowDown;
        return <th key={key} scope="col" aria-sort={active ? sort.direction : "none"}>
          <button type="button" aria-label={accessible} title={key === "model" ? `模型名稱 ${active && ascending ? "Z → A" : "A → Z"} 排序` : `${label}${active && ascending ? "由高到低" : "由低到高"}排序`} onClick={() => sortBy(key)}>
            <span className="pricing-sort-label">{label}{english ? <span>{english}</span> : null}</span><Icon size={16} aria-hidden="true" />
          </button>
        </th>;
      })}<th scope="col" aria-label="操作" /></tr></thead>
      <tbody>{visible.map(({ model, rule }) => {
        const officialRule = official.get(keyOf(model));
        const custom = rule && (!officialRule || !samePrices(rule, officialRule));
        return <tr key={keyOf(model)}>
          <th scope="row"><span className="pricing-model-name">{model}</span><span className="pricing-model-notes">{!rule ? <span className="pricing-badge unpriced">尚未定價</span> : custom ? <span className="pricing-badge custom">自訂</span> : null}{used.has(keyOf(model)) ? <span>本期使用</span> : null}</span>{rule && hasLongContextPricing(rule) ? <span className="pricing-context-note">輸入 &gt; {thresholdLabel(rule.longContextThreshold)}：輸入／快取 ×{price(rule.longInputMultiplier)} · 輸出 ×{price(rule.longOutputMultiplier)}</span> : null}</th>
          <td data-label="輸入">{rule ? price(rule.inputUsdPerMillion) : "—"}</td>
          <td data-label="快取輸入">{rule && !rule.unavailableRates?.includes("cached") ? price(rule.cachedUsdPerMillion) : "—"}</td>
          <td data-label="輸出">{rule ? price(rule.outputUsdPerMillion) : "—"}</td>
          <td className="pricing-row-action"><button type="button" disabled={busy} aria-label={`${rule ? "編輯" : "設定"} ${model} 價格`} onClick={() => open(model, rule)}>{rule ? <Pencil size={14} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}{rule ? "編輯" : "設定"}</button></td>
        </tr>;
      })}</tbody>
    </table>
    {!visible.length ? <div className="pricing-empty"><strong>{search ? "找不到符合的模型" : "尚未設定模型價格"}</strong><p>{search ? "試試較短的名稱，或新增自訂價格。" : "更新官方價格，或新增自訂價格。"}</p>{search ? <button type="button" className="secondary-button" onClick={() => { setSearch(""); searchRef.current?.focus(); }}>清除搜尋</button> : null}</div> : null}
    {editing ? <PriceDialog model={editing.model} original={editing.original} official={official.get(keyOf(editing.model)) ?? null} rules={rules} onSave={commit} onDismiss={dismiss} /> : null}
  </div>;
}

function PriceDialog({ model: initialModel, original, official, rules, onSave, onDismiss }: { model: string; original: PricingRule | null; official: PricingRule | null; rules: PricingRule[]; onSave: Commit; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const [model, setModel] = useState(initialModel);
  const [values, setValues] = useState(() => valuesOf(original));
  const [basis, setBasis] = useState(original ?? newRule(initialModel));
  const [longEnabled, setLongEnabled] = useState(() => !!original && hasLongContextPricing(original));
  const [contextValues, setContextValues] = useState(() => contextValuesOf(original));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState("");
  const [removePrompt, setRemovePrompt] = useState(false);
  const id = useId();
  const name = model.trim() || "新模型";
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    element.showModal();
    if (!original) modelInput.current?.focus();
    else element.querySelector<HTMLInputElement>('input[type="number"]')?.focus();
    return () => { element.close(); document.documentElement.style.overflow = overflow; };
  }, [original]);

  const persist = async (rule: PricingRule | null) => {
    setSaving(true); setError(""); setInvalidField("");
    try { await onSave(rule, original); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSaving(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!model.trim()) { setError("請輸入模型名稱。"); setInvalidField("model"); modelInput.current?.focus(); return; }
    if (rules.some(rule => keyOf(rule.model) === keyOf(model) && keyOf(rule.model) !== keyOf(original?.model ?? ""))) { setError("這個模型已經有價格，請編輯現有模型。"); setInvalidField("model"); modelInput.current?.focus(); return; }
    for (const { field, label, unavailable } of fields) {
      if ((!unavailable && !values[field].trim()) || values[field] && (!Number.isFinite(Number(values[field])) || Number(values[field]) < 0)) {
        setError(field === "priorityMultiplier" ? "Fast / Priority 倍率請填 0 或正數，未公布可留空。" : `${label}請填寫價格（0 或正數）。`);
        setInvalidField(field);
        dialog.current?.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus(); return;
      }
    }
    if (longEnabled) for (const { field, label } of contextFields) {
      const value = Number(contextValues[field]);
      if (!contextValues[field].trim() || !Number.isFinite(value) || value <= 0 || field === "longContextThreshold" && !Number.isSafeInteger(value)) {
        setError(`${label}請填寫${field === "longContextThreshold" ? "正整數" : "大於 0 的數字"}。`);
        setInvalidField(field); dialog.current?.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus(); return;
      }
    }
    const numbers = Object.fromEntries(fields.map(({ field, unavailable }) => [field, unavailable && !values[field].trim() ? basis[field] : Number(values[field]) || 0])) as Record<PriceField, number>;
    const unavailableRates = [...fields.filter(({ field, unavailable }) => unavailable && !values[field].trim()).map(field => field.unavailable!), ...(basis.unavailableRates ?? []).filter(rate => !fields.some(field => field.unavailable === rate) && (longEnabled || rate !== "longFast"))];
    const context = longEnabled ? Object.fromEntries(contextFields.map(({ field }) => [field, Number(contextValues[field])])) as Record<ContextField, number>
      : { longContextThreshold: basis.longContextThreshold, longInputMultiplier: 1, longOutputMultiplier: 1 };
    void persist({ ...basis, ...numbers, ...context, model: model.trim(), unavailableRates });
  };
  const clearError = () => { setError(""); setInvalidField(""); };
  const renderField = ({ field, label, accessible, unavailable }: typeof fields[number]) => <label key={field}><span>{label}</span><input name={field} aria-label={`${name} ${accessible}`} aria-invalid={invalidField === field || undefined} aria-describedby={invalidField === field ? `${id}-error` : undefined} disabled={saving} type="number" min="0" step="any" inputMode="decimal" placeholder={unavailable ? "未提供（選填）" : "請填寫價格"} value={values[field]} onChange={event => { setValues(current => ({ ...current, [field]: event.target.value })); clearError(); }} /></label>;
  const longRates = fields.filter(item => item.field !== "priorityMultiplier").map(({ field, label }) => {
    const multiplier = Number(contextValues[field === "outputUsdPerMillion" ? "longOutputMultiplier" : "longInputMultiplier"]);
    const value = Number(values[field]);
    return { label, value: values[field].trim() && Number.isFinite(value) && Number.isFinite(multiplier) && multiplier > 0 ? `$${price(value * multiplier)}` : "—" };
  });

  return <dialog ref={dialog} className="price-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); if (!saving) onDismiss(); }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <form onSubmit={submit} noValidate>
      <div className="price-dialog-heading"><div><h2 id={`${id}-title`}>{original ? "編輯模型價格" : "新增自訂價格"}</h2><p id={`${id}-description`}>美元／每百萬 Tokens · 保存後重新計算估算費用</p></div><button type="button" className="price-dialog-close" aria-label="關閉價格編輯" disabled={saving} onClick={onDismiss}><X size={19} /></button></div>
      <div className="price-dialog-body">
        <label className="price-model-field"><span>模型名稱</span><input ref={modelInput} aria-label="模型名稱" aria-invalid={invalidField === "model" || undefined} aria-describedby={invalidField === "model" ? `${id}-error` : undefined} value={model} placeholder="例如 codex-auto-review" disabled={saving} onChange={event => { setModel(event.target.value); clearError(); }} /></label>
        <div className="price-edit-columns"><div>
        <section className="price-base-section" aria-label="一般單價"><h3>一般單價</h3><div className="pricing-fields">{fields.filter(item => item.field !== "priorityMultiplier").map(renderField)}</div></section>
        <div className="pricing-fields price-priority-field">{renderField(fields[4])}<p className="price-field-hint">使用 Fast / Priority 時，再套用此倍率。</p></div>
        </div>
        <section className="price-context-section" aria-labelledby={`${id}-context-title`}>
          <label className="price-context-toggle"><input type="checkbox" aria-label={`${name} 啟用長 context 加價`} checked={longEnabled} disabled={saving} onChange={event => { setLongEnabled(event.target.checked); clearError(); }} /><span id={`${id}-context-title`}>長 context 加價</span></label>
          {longEnabled ? <>
            <p className="price-field-hint" id={`${id}-context-help`}>單次請求的輸入（含快取）超過門檻，整筆輸入與輸出都套用加價。</p>
            <div className="pricing-fields price-context-fields">{contextFields.map(({ field, label, accessible }) => <label key={field}><span>{label}</span><input name={field} aria-label={`${name} ${accessible}`} aria-invalid={invalidField === field || undefined} aria-describedby={invalidField === field ? `${id}-error` : `${id}-context-help`} disabled={saving} type="number" min={field === "longContextThreshold" ? "1" : "0"} step={field === "longContextThreshold" ? "1" : "any"} inputMode={field === "longContextThreshold" ? "numeric" : "decimal"} placeholder={field === "longContextThreshold" ? "例如 272000" : "倍率"} value={contextValues[field]} onChange={event => { setContextValues(current => ({ ...current, [field]: event.target.value })); clearError(); }} /></label>)}</div>
            <div className="price-long-preview" aria-label="長 context 單價"><p>加價後單價 · 美元／每百萬 Tokens</p><dl>{longRates.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>
            {basis.unavailableRates?.includes("longFast") ? <p className="price-field-hint">官方未提供長 context 的 Fast / Priority 價格，這類用量會顯示為尚未定價。</p> : null}
          </> : <p className="price-field-hint">輸入長度不影響單價。</p>}
        </section>
        </div>
        {official ? <button type="button" className="link-button price-use-official" disabled={saving} onClick={() => { setBasis(official); setModel(official.model); setValues(valuesOf(official)); setLongEnabled(hasLongContextPricing(official)); setContextValues(contextValuesOf(official)); clearError(); }}><RotateCcw size={14} aria-hidden="true" />使用官方價格與加價規則</button> : <p className="price-field-hint">未公布的價格可留空；輸入與輸出價格必須填寫。</p>}
        {removePrompt ? <div className="price-remove-prompt"><p>移除 {original?.model} 的自訂價格？這個模型的用量將顯示為尚未定價。</p><button type="button" className="danger-button" disabled={saving} onClick={() => void persist(null)}>確認移除</button><button type="button" className="secondary-button" disabled={saving} onClick={() => setRemovePrompt(false)}>保留價格</button></div> : null}
      </div>
      {error ? <p id={`${id}-error`} className="price-dialog-error inline-status error" role="alert">{error}</p> : null}
      <div className="price-dialog-footer">{original && !official ? <button type="button" className="price-remove" disabled={saving} onClick={() => setRemovePrompt(true)}>移除自訂價格</button> : <span />}<button type="button" className="secondary-button" disabled={saving} onClick={onDismiss}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="price-spinner" size={16} aria-hidden="true" /> : null}{saving ? "保存中…" : "保存價格"}</button></div>
    </form>
  </dialog>;
}
