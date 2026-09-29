/*
 * CampusClaw —— 第 4 课：材料切分模块
 *
 * 职责：把一份正文切成若干切片。**只读不改** —— 切分结果写进切片表，
 *       绝不回写 knowledge_entries.body_text，也不调用嵌入、不碰向量库。
 *       （规约里这条是硬约束：切片偏移是相对「预处理后文本」的，
 *         一旦改写原文，偏移就再也对不回原文件了。）
 *
 * 三种策略：
 *   auto      最大 800 字、重叠 80 字；断句优先级 空行 → 换行 → 句号 → 强制截断
 *   custom    长度 100–2000、重叠 0%–50%；可选移除 URL / 邮箱、折叠空白
 *   hierarchy 按 Markdown 的 # / ## / ### 分章，标题留在该章切片内；超长章节按 auto 二次切分
 *   未指定 → auto
 */

const AUTO_MAX = 800;
const AUTO_OVERLAP = 80;
const CUSTOM_MIN = 100;
const CUSTOM_MAX = 2000;
const CUSTOM_OVERLAP_MAX = 0.5;

/* 参数越界的信号：调用方据此返回 400，而不是悄悄夹到边界值。
   夹边界会让「长度 5000」这种明显写错的请求变成合法请求，
   用户以为生效了、其实拿到的是别的策略的切片。 */
class SplitParamError extends Error {
  constructor(msg) { super(msg); this.badParams = true; }
}

/* ---------- 预处理 ---------- */
/* 注意：预处理只作用于「待切分文本」，body_text 永远保持原样。 */
function preprocess(text, opt) {
  opt = opt || {};
  let t = String(text == null ? '' : text);
  if (opt.stripUrls) {
    t = t.replace(/https?:\/\/[^\s<>"'）)】\]]+/gi, ' ');
  }
  if (opt.stripEmails) {
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ');
  }
  if (opt.collapseSpaces) {
    /* 折叠「连续空白」为单个空格：先把 \r\n 归一成 \n，
       再把不含换行的空白串折叠 —— 保留换行是为了后续断句还能用上它。 */
    t = t.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0\u3000]+/g, ' ');
  }
  return t;
}

/* ---------- 断点查找 ---------- */
/* 在 [from, limit) 里从后往前找「最好的断点」。
   优先级：空行 > 换行 > 句号（。！？!?）> 英文句点+空格 > 逗号/分号 > 空格。
   从前往后会很早断开、切片偏短；从后往前能让切片尽量接近上限，
   同时仍在语义边界上收尾。 */
function findBreak(text, from, limit) {
  if (limit >= text.length) return text.length;
  const floor = from + Math.floor((limit - from) * 0.5);  // 最远回溯到一半，避免切得过碎

  const tiers = [
    ['\n\n', 2], ['\n', 1], ['。', 1], ['！', 1], ['？', 1],
    ['!', 1], ['?', 1], ['. ', 2], ['；', 1], [';', 1],
    ['，', 1], [',', 1], [' ', 1]
  ];
  for (const [mark, lead] of tiers) {
    const at = text.lastIndexOf(mark, limit - 1);
    if (at >= floor) return at + lead;
  }
  return limit;   // 无任何断点 → 按最大长度强制截断
}

/* ---------- auto 策略 ---------- */
function splitAuto(text, maxLen, overlap) {
  const out = [];
  const n = text.length;
  let start = 0;
  /* 防御：重叠必须小于步长，否则游标会原地打转、切成无限多片 */
  const ov = Math.min(overlap, Math.max(0, maxLen - 1));
  while (start < n) {
    const limit = Math.min(start + maxLen, n);
    let end = findBreak(text, start, limit);
    if (end <= start) end = limit;
    if (end > n) end = n;
    /* 区间必须以「原文真实下标」为准。
       末片之后还有重叠时，end 可能落在 n 之前，由下一轮继续；
       这里统一在 push 之前把 end 夹回 n，保证 end 永不越过文本长度。 */
    out.push({ text: text.slice(start, end), start, end });
    if (end >= n) break;
    start = Math.max(start + 1, end - ov);
    /* 只在空白处起头，切片开头就不会带着半个词 */
    while (start < n && /[\s\u3000]/.test(text[start]) && start < end) start++;
  }
  return out;
}

/* ---------- custom 策略 ---------- */
function splitCustom(text, maxLen, overlapLen) {
  return splitAuto(text, maxLen, overlapLen);
}

/* ---------- hierarchy 策略 ---------- */
/* 按 Markdown 标题分章。只在「不在代码围栏内」的标题行上切 ——
   否则文档里示例代码的 `# 注释` 会被当成章节标题，把正文切得莫名其妙。 */
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;

function scanHeadings(text) {
  const heads = [];
  let offset = 0;
  let inFence = false;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (!inFence) {
      const m = HEADING_RE.exec(trimmed);
      if (m) heads.push({ level: m[1].length, title: m[2], at: offset });
    }
    offset += line.length + 1;
  }
  return heads;
}

function splitHierarchy(text, maxLen, overlap) {
  const heads = scanHeadings(text);
  if (!heads.length) return splitAuto(text, maxLen, overlap);   // 没有标题 → 退化为 auto

  const out = [];
  // 第一个标题之前的内容单独成段（前言不属于任何章）
  if (heads[0].at > 0) {
    const pre = text.slice(0, heads[0].at);
    if (pre.trim()) out.push({ text: pre.trimEnd(), start: 0, end: heads[0].at });
  }

  for (let i = 0; i < heads.length; i++) {
    const secStart = heads[i].at;
    const secEnd = i + 1 < heads.length ? heads[i + 1].at : text.length;
    const section = text.slice(secStart, secEnd);
    if (!section.trim()) continue;

    if (section.length <= maxLen) {
      // 标题与正文同处一条切片
      out.push({ text: section.trimEnd(), start: secStart, end: secEnd });
    } else {
      /* 超过上限 → 按 auto 规则二次切分。
         **偏移按「整篇」计**：二次切分是在 section 这个子串上做的，
         返回的 start/end 相对子串，必须加上 secStart 才能拿去回溯原文。
         末尾那一片的 end 夹到 secEnd：auto 的末片理论上已收到子串长度，
         但重叠游标有可能让它探出边界，夹一下才能保证「本片区间不侵入下一章」。 */
      for (const piece of splitAuto(section, maxLen, overlap)) {
        const absStart = secStart + piece.start;
        const absEnd = Math.min(secStart + piece.end, secEnd);
        if (absEnd <= absStart) continue;
        out.push({
          text: text.slice(absStart, absEnd).trimEnd(),
          start: absStart,
          end: absEnd
        });
      }
    }
  }
  return out;
}

/* ---------- 对外入口 ---------- */
/**
 * @param {string} text 待切分正文（**不会被修改**）
 * @param {object} opts { strategy, maxLen, overlap, overlapRatio, stripUrls, stripEmails, collapseSpaces }
 * @returns {{strategy:string, maxLen:number, overlap:number, chunks:Array<{text,start,end,index}>}}
 * @throws {SplitParamError} 参数越界
 */
function split(text, opts) {
  const o = opts || {};
  const strategy = o.strategy || 'auto';      // 未指定策略 → auto
  const src = String(text == null ? '' : text);

  if (strategy === 'custom') {
    const maxLen = Number(o.maxLen);
    if (!Number.isInteger(maxLen) || maxLen < CUSTOM_MIN || maxLen > CUSTOM_MAX) {
      throw new SplitParamError(
        `custom 策略的最大长度需为 ${CUSTOM_MIN}–${CUSTOM_MAX} 之间的整数`);
    }
    /* 重叠接受两种写法：overlap 绝对字数 / overlapRatio 比例。
       比例上限 50% —— 再多就没有信息增量了，纯粹是重复内容占坑。 */
    let overlap;
    if (o.overlapRatio != null) {
      const ratio = Number(o.overlapRatio);
      if (!(ratio >= 0 && ratio <= CUSTOM_OVERLAP_MAX)) {
        throw new SplitParamError('custom 策略的重叠比例需在 0%–50% 之间');
      }
      overlap = Math.floor(maxLen * ratio);
    } else {
      overlap = Number(o.overlap || 0);
      if (!Number.isFinite(overlap) || overlap < 0) {
        throw new SplitParamError('custom 策略的重叠字数不能为负');
      }
      if (overlap > maxLen * CUSTOM_OVERLAP_MAX) {
        throw new SplitParamError('custom 策略的重叠不超过最大长度的 50%');
      }
    }
    const prepared = preprocess(src, o);
    const parts = splitCustom(prepared, maxLen, overlap);
    return finalize('custom', maxLen, overlap, parts, prepared);

  } else if (strategy === 'hierarchy') {
    const prepared = preprocess(src, o);
    const parts = splitHierarchy(prepared, AUTO_MAX, AUTO_OVERLAP);
    return finalize('hierarchy', AUTO_MAX, AUTO_OVERLAP, parts, prepared);

  } else {
    /* auto：请求里另行填写的长度与预处理参数**不生效**（规约明写），
       一切按固定的 800 / 80 走。 */
    const prepared = String(src);
    const parts = splitAuto(prepared, AUTO_MAX, AUTO_OVERLAP);
    return finalize('auto', AUTO_MAX, AUTO_OVERLAP, parts, prepared);
  }
}

/* 收尾：丢掉纯空白切片、重排 chunk_index（从 0 起连续）。
   index 必须连续 —— 它是「第几片」的唯一凭据，中间断号会让
   「切片序号」这个可溯源字段失去意义。 */
function finalize(strategy, maxLen, overlap, parts, prepared) {
  const chunks = [];
  for (const p of parts) {
    if (!p.text.trim()) continue;
    chunks.push({
      index: chunks.length,
      text: p.text,
      start: p.start,
      end: p.end
    });
  }
  return { strategy, maxLen, overlap, sourceLength: prepared.length, chunks };
}

module.exports = {
  split, preprocess, scanHeadings, SplitParamError,
  AUTO_MAX, AUTO_OVERLAP, CUSTOM_MIN, CUSTOM_MAX, CUSTOM_OVERLAP_MAX
};
