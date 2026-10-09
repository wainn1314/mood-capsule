/* ============================================================
 * 情绪胶囊生成组件（JavaScript 版）
 * 与 emotion_capsule_svg.py 保持一致，纯前端、零外部依赖。
 * 用法：
 *   MoodCapsule.generateCapsuleSvg(emotionType, intensity, color, design)
 *   MoodCapsule.suggestDesign(emotionType, intensity, context)
 * design = { icon, decorations, levelText }，缺省时自动用规则兜底。
 * intensity 为 0-100 百分比；color 为十六进制色值。
 * ============================================================ */
(function (global) {
  'use strict';

  let _uid = 0;

  function nextUid() {
    _uid += 1;
    return 'mc' + _uid + '_' + Math.random().toString(36).slice(2, 7);
  }

  function hexToRgb(color) {
    let c = String(color || '').trim().replace(/^#/, '');
    if (c.length === 3) {
      c = c.split('').map(function (ch) { return ch + ch; }).join('');
    }
    if (c.length !== 6) c = 'FF6B6B';
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    if ([r, g, b].some(function (n) { return Number.isNaN(n); })) {
      return [255, 107, 107];
    }
    return [r, g, b];
  }

  function rgba(color, alpha) {
    const rgb = hexToRgb(color);
    return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + alpha + ')';
  }

  function normalizeColor(color) {
    const rgb = hexToRgb(color);
    function h(n) { return n.toString(16).padStart(2, '0').toUpperCase(); }
    return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
  }

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function clampIntensity(value) {
    const v = parseFloat(value);
    if (Number.isNaN(v)) return 0;
    return Math.max(0, Math.min(100, v));
  }

  function intensityLevel(intensity) {
    const v = Math.round(clampIntensity(intensity));
    if (v <= 24) return '情绪平静';
    if (v <= 49) return '情绪轻微';
    if (v <= 79) return '情绪明显';
    return '情绪强烈';
  }

  function fmtNum(n) {
    return String(Math.round(n * 100) / 100);
  }

  // ---------- 图标库（按情绪语义匹配，禁止总用心形） ----------
  // 每个图标绘制在以 (0,0) 为中心、约 44px 见方的坐标系内，用主色填充/描边。
  const ICONS = {
    waves: (c) =>
      '<g stroke="' + c + '" stroke-width="3" fill="none" stroke-linecap="round">' +
      '<path d="M-20 -8 Q-15 -14 -10 -8 T0 -8 T10 -8 T20 -8"/>' +
      '<path d="M-20 0 Q-15 -6 -10 0 T0 0 T10 0 T20 0"/>' +
      '<path d="M-20 8 Q-15 2 -10 8 T0 8 T10 8 T20 8"/>' +
      '</g>',
    spiral: (c) =>
      '<path d="M0 -2 C4 -2 6 1 6 5 C6 9 2 12 -2 12 C-8 12 -12 8 -12 2 C-12 -6 -6 -12 2 -12 C12 -12 18 -6 18 2 C18 11 11 18 1 18" fill="none" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>',
    stars: (c) =>
      '<path d="M0 -16 L4.7 -5 L16 -5 L7 2.5 L10 14 L0 7 L-10 14 L-7 2.5 L-16 -5 L-4.7 -5 Z" fill="' + c + '"/>' +
      '<circle cx="14" cy="-12" r="2" fill="' + c + '"/>',
    sun: (c) =>
      '<circle cx="0" cy="0" r="10" fill="' + c + '"/>' +
      '<g stroke="' + c + '" stroke-width="3" stroke-linecap="round">' +
      '<line x1="0" y1="-20" x2="0" y2="-14"/><line x1="0" y1="14" x2="0" y2="20"/>' +
      '<line x1="-20" y1="0" x2="-14" y2="0"/><line x1="14" y1="0" x2="20" y2="0"/>' +
      '<line x1="14" y1="-14" x2="10" y2="-10"/><line x1="-14" y1="-14" x2="-10" y2="-10"/>' +
      '<line x1="14" y1="14" x2="10" y2="10"/><line x1="-14" y1="14" x2="-10" y2="10"/>' +
      '</g>',
    smile: (c) =>
      '<circle cx="0" cy="0" r="16" fill="none" stroke="' + c + '" stroke-width="3"/>' +
      '<circle cx="-6" cy="-4" r="2.2" fill="' + c + '"/><circle cx="6" cy="-4" r="2.2" fill="' + c + '"/>' +
      '<path d="M-8 4 Q0 12 8 4" fill="none" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>',
    rain: (c) =>
      '<circle cx="-8" cy="2" r="7" fill="' + c + '"/><circle cx="0" cy="-3" r="9" fill="' + c + '"/><circle cx="8" cy="2" r="7" fill="' + c + '"/>' +
      '<rect x="-8" y="0" width="16" height="8" rx="4" fill="' + c + '"/>' +
      '<g stroke="' + c + '" stroke-width="3" stroke-linecap="round">' +
      '<line x1="-10" y1="12" x2="-12" y2="18"/><line x1="0" y1="13" x2="0" y2="20"/><line x1="10" y1="12" x2="8" y2="18"/>' +
      '</g>',
    cloud: (c) =>
      '<circle cx="-8" cy="2" r="7" fill="' + c + '"/><circle cx="0" cy="-3" r="9" fill="' + c + '"/><circle cx="8" cy="2" r="7" fill="' + c + '"/>' +
      '<rect x="-8" y="0" width="16" height="8" rx="4" fill="' + c + '"/>',
    leaf: (c) =>
      '<path d="M2 -16 C14 -8 16 4 8 12 C0 20 -16 12 -10 0 C-6 -8 0 -14 2 -16 Z" fill="' + c + '"/>' +
      '<path d="M2 -14 C4 -6 3 4 0 12" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2" stroke-linecap="round"/>',
    lightning: (c) =>
      '<path d="M4 -18 L-8 2 L-2 2 L-4 18 L10 -4 L3 -4 L8 -18 Z" fill="' + c + '"/>',
    flame: (c) =>
      '<path d="M0 -18 C8 -10 14 -6 14 2 C14 12 6 18 -2 16 C-8 14 -10 6 -6 0 C-3 -4 0 -6 0 -18 Z" fill="' + c + '"/>' +
      '<path d="M0 -4 C4 2 4 8 0 12 C-3 8 -3 2 0 -4 Z" fill="rgba(255,255,255,0.55)"/>',
    zigzag: (c) =>
      '<path d="M-18 6 L-8 -6 L-2 6 L8 -6 L18 6" fill="none" stroke="' + c + '" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>',
    water: (c) =>
      '<g fill="none" stroke="' + c + '" stroke-width="3" stroke-linecap="round">' +
      '<path d="M-12 0 A12 12 0 0 1 12 0"/><path d="M-6 8 A6 6 0 0 1 6 8"/><path d="M-18 -8 A18 18 0 0 1 18 -8"/>' +
      '</g>',
    moon: (c) =>
      '<path d="M8 -14 A14 14 0 1 0 8 14 A11 11 0 1 1 8 -14 Z" fill="' + c + '"/>',
    feather: (c) =>
      '<path d="M-2 -20 C-10 -6 -10 8 -4 18 C-6 8 -2 -2 0 -20 Z" fill="' + c + '"/>' +
      '<path d="M-2 -18 C-4 -2 -4 10 -2 18" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2" stroke-linecap="round"/>',
    eye: (c) =>
      '<path d="M-20 0 C-10 -12 10 -12 20 0 C10 12 -10 12 -20 0 Z" fill="none" stroke="' + c + '" stroke-width="3"/>' +
      '<circle cx="0" cy="0" r="7" fill="' + c + '"/><circle cx="0" cy="0" r="3" fill="#ffffff"/>',
    crack: (c) =>
      '<path d="M-14 -16 L-4 -6 L-10 0 L0 6 L-8 14" fill="none" stroke="' + c + '" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path d="M-10 0 L4 -2 L10 2" fill="none" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>',
    sparkles: (c) =>
      '<path d="M0 -16 L3 -4 L16 0 L3 4 L0 16 L-3 4 L-16 0 L-3 -4 Z" fill="' + c + '"/>' +
      '<circle cx="14" cy="-14" r="2.5" fill="' + c + '"/><circle cx="-14" cy="12" r="2" fill="' + c + '"/>',
  };
  const ICON_KEYS = Object.keys(ICONS);

  // ---------- 背景装饰库（绝对坐标，位于四角，绝不遮挡文字/进度条） ----------
  const DECORATIONS = {
    rays: (c) =>
      '<g stroke="' + c + '" stroke-width="2" stroke-linecap="round">' +
      '<line x1="36" y1="36" x2="24" y2="16"/><line x1="36" y1="36" x2="44" y2="12"/><line x1="36" y1="36" x2="60" y2="16"/>' +
      '<line x1="444" y1="36" x2="456" y2="16"/><line x1="444" y1="36" x2="436" y2="12"/><line x1="444" y1="36" x2="420" y2="16"/>' +
      '</g>',
    shards: (c) =>
      '<g fill="' + c + '">' +
      '<path d="M48 26 L54 36 L42 36 Z"/><path d="M420 58 L427 67 L413 67 Z"/>' +
      '<path d="M40 200 L45 208 L35 208 Z"/><path d="M430 218 L436 227 L424 227 Z"/>' +
      '</g>',
    dots: (c) =>
      '<g fill="' + c + '">' +
      '<circle cx="50" cy="30" r="4"/><circle cx="70" cy="48" r="2.5"/>' +
      '<circle cx="420" cy="36" r="3.5"/><circle cx="445" cy="55" r="2"/>' +
      '<circle cx="55" cy="230" r="3"/><circle cx="430" cy="236" r="3.5"/>' +
      '</g>',
    curves: (c) =>
      '<g stroke="' + c + '" stroke-width="2" fill="none" stroke-linecap="round">' +
      '<path d="M36 232 Q50 224 64 232 T92 232"/><path d="M388 232 Q402 224 416 232 T444 232"/>' +
      '<path d="M50 40 Q60 34 70 40"/><path d="M410 40 Q420 34 430 40"/>' +
      '</g>',
  };
  const DECORATION_KEYS = Object.keys(DECORATIONS);

  // ---------- 规则兜底设计（大模型不可用时使用） ----------
  function detectScene(context) {
    const t = String(context || '');
    if (/工作|加班|老板|同事|项目|压力|deadline|考试|复习|学习|作业|汇报|绩效/i.test(t)) return 'work';
    if (/社交|朋友|聚会|人际|社恐|同学|群体|热闹|冷场/i.test(t)) return 'social';
    if (/恋爱|喜欢|暗恋|分手|失恋|感情|爱情|想念|心碎|暧昧|表白/i.test(t)) return 'love';
    return null;
  }

  function levelText(intensity, context) {
    const v = Math.round(clampIntensity(intensity));
    const band = v <= 24 ? 0 : v <= 49 ? 1 : v <= 79 ? 2 : 3;
    const scene = detectScene(context);
    if (scene === 'work') return ['压力感平静', '压力感较轻', '压力感较强', '压力感很大'][band];
    if (scene === 'social') return ['社交能量低', '社交能量偏低', '社交能量充足', '社交能量满格'][band];
    if (scene === 'love') return ['心情平静', '心情微澜', '心情波动', '心情翻涌'][band];
    return ['情绪平静', '情绪轻微', '情绪明显', '情绪强烈'][band];
  }

  function matchIcon(emotionType) {
    const t = String(emotionType || '');
    if (/焦虑|紧张|不安|担心|着急|纠结|慌乱|忐忑/.test(t)) return 'waves';
    if (/开心|兴奋|高兴|快乐|喜悦|激动|满足|欢欣|愉快/.test(t)) return 'stars';
    if (/悲伤|伤心|难过|失落|沮丧|低落|哭泣|委屈|忧伤|心碎/.test(t)) return 'rain';
    if (/愤怒|生气|烦躁|暴怒|恼火|发火|气恼/.test(t)) return 'lightning';
    if (/恐惧|害怕|惊恐|畏惧|恐慌/.test(t)) return 'eye';
    if (/平静|放松|安静|平和|松弛|舒缓|宁静/.test(t)) return 'water';
    if (/疲惫|劳累|困倦|乏力|倦怠|疲乏/.test(t)) return 'moon';
    return 'sparkles';
  }

  function suggestDecorations(intensity, emotionType) {
    const v = clampIntensity(intensity);
    const t = String(emotionType || '');
    const high = /愤怒|生气|兴奋|激动|开心|焦虑|紧张|暴怒|烦躁/.test(t);
    const low = /平静|放松|悲伤|难过|低落|忧伤|沮丧|宁静|疲惫|孤独/.test(t);
    if (v >= 60 && high) return ['rays', 'shards'];
    if (v < 40 || low) return ['dots', 'curves'];
    return ['dots'];
  }

  function suggestDesign(emotionType, intensity, context) {
    return {
      icon: matchIcon(emotionType),
      decorations: suggestDecorations(intensity, emotionType),
      levelText: levelText(intensity, context),
    };
  }

  function normalizeDecorations(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const k = arr[i];
      if (DECORATIONS[k] && out.indexOf(k) === -1) out.push(k);
      if (out.length >= 3) break;
    }
    return out;
  }

  function decorationAlpha(intensity) {
    const v = clampIntensity(intensity);
    if (v >= 60) return 0.20;
    if (v < 40) return 0.14;
    return 0.16;
  }

  // ---------- 情绪主题背景纹样（按情绪特征增强氛围） ----------
  function emotionMotif(emotionType, color) {
    const t = String(emotionType || '');
    const c = color;
    // 开心 / 兴奋：四芒星光点
    if (/开心|兴奋|高兴|快乐|喜悦|激动|满足|欢欣|愉快|幸福/.test(t)) {
      return '<g fill="' + c + '" opacity="0.22">' +
        '<path d="M70 66 L73 74 L82 77 L73 80 L70 88 L67 80 L58 77 L67 74 Z"/>' +
        '<path d="M410 70 L412 76 L418 78 L412 80 L410 86 L408 80 L402 78 L408 76 Z"/>' +
        '<path d="M78 214 L81 221 L88 224 L81 227 L78 234 L75 227 L68 224 L75 221 Z"/>' +
        '<path d="M400 200 L402 206 L408 208 L402 210 L400 216 L398 210 L392 208 L398 206 Z"/>' +
        '</g>';
    }
    // 悲伤 / 低落：细密雨丝
    if (/悲伤|伤心|难过|失落|沮丧|低落|哭泣|委屈|忧伤|心碎|孤独|想念/.test(t)) {
      return '<g stroke="' + c + '" stroke-width="1.6" stroke-linecap="round" opacity="0.20">' +
        '<line x1="58" y1="46" x2="54" y2="66"/><line x1="76" y1="42" x2="72" y2="62"/>' +
        '<line x1="404" y1="52" x2="400" y2="72"/><line x1="424" y1="46" x2="420" y2="66"/>' +
        '<line x1="446" y1="54" x2="442" y2="74"/>' +
        '<line x1="66" y1="200" x2="62" y2="220"/><line x1="418" y1="204" x2="414" y2="224"/><line x1="440" y1="196" x2="436" y2="216"/>' +
        '</g>';
    }
    // 愤怒 / 烦躁：锯齿张力线
    if (/愤怒|生气|烦躁|暴怒|恼火|发火|气恼/.test(t)) {
      return '<g stroke="' + c + '" stroke-width="2" stroke-linejoin="round" opacity="0.22" fill="none">' +
        '<path d="M58 70 L70 58 L82 70"/><path d="M398 70 L410 58 L422 70"/>' +
        '<path d="M62 214 L74 202 L86 214"/><path d="M402 214 L414 202 L426 214"/>' +
        '</g>';
    }
    // 平静 / 放松 / 疲惫：涟漪弧线
    if (/平静|放松|安静|平和|松弛|舒缓|宁静|安眠|惬意|疲惫|劳累|困倦|乏力/.test(t)) {
      return '<g fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" opacity="0.20">' +
        '<path d="M34 150 A40 40 0 0 1 74 110"/><path d="M30 172 A56 56 0 0 1 86 116"/>' +
        '<path d="M446 150 A40 40 0 0 0 406 110"/><path d="M450 172 A56 56 0 0 0 394 116"/>' +
        '</g>';
    }
    // 焦虑 / 紧张：波浪细线
    if (/焦虑|紧张|不安|担心|着急|纠结|慌乱|忐忑/.test(t)) {
      return '<g fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" opacity="0.22">' +
        '<path d="M40 60 Q52 50 64 60 T88 60"/><path d="M392 60 Q404 50 416 60 T440 60"/>' +
        '<path d="M40 214 Q52 204 64 214 T88 214"/><path d="M392 214 Q404 204 416 214 T440 214"/>' +
        '</g>';
    }
    // 恐惧 / 害怕：裂纹细线
    if (/恐惧|害怕|惊恐|畏惧|恐慌/.test(t)) {
      return '<g stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" opacity="0.22" fill="none">' +
        '<path d="M60 60 L72 72 L66 84"/><path d="M420 60 L408 72 L414 84"/>' +
        '<path d="M60 208 L70 220 L64 232"/><path d="M420 208 L410 220 L416 232"/>' +
        '</g>';
    }
    // 默认：漂浮圆点
    return '<g fill="' + c + '" opacity="0.20">' +
      '<circle cx="70" cy="62" r="3"/><circle cx="410" cy="66" r="2.6"/>' +
      '<circle cx="84" cy="212" r="2.6"/><circle cx="402" cy="206" r="3"/>' +
      '</g>';
  }

  // ---------- 四角卷曲藤蔓装饰 ----------
  function cornerSwirls(color) {
    const c = color;
    return '<g fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" opacity="0.30">' +
      '<path d="M42 40 Q28 40 26 54 Q24 66 34 68"/>' +
      '<path d="M438 40 Q452 40 454 54 Q456 66 446 68"/>' +
      '<path d="M42 240 Q28 240 26 226 Q24 214 34 212"/>' +
      '<path d="M438 240 Q452 240 454 226 Q456 214 446 212"/>' +
      '</g>';
  }

  function generateCapsuleSvg(emotionType, intensity, color, design) {
    const v = clampIntensity(intensity);
    const displayIntensity = Math.round(v);
    const mainColor = normalizeColor(color);
    const label = escapeXml(emotionType) || '情绪';
    const uid = nextUid();

    let d;
    if (design && design.icon && ICONS[design.icon]) {
      d = {
        icon: design.icon,
        decorations: normalizeDecorations(design.decorations),
        levelText: (typeof design.levelText === 'string' && design.levelText.trim()) ? design.levelText.trim() : intensityLevel(v),
      };
    } else {
      d = suggestDesign(emotionType, v, '');
    }

    const fillWidth = fmtNum(Math.round((300 * v / 100) * 100) / 100);
    const barRx = fmtNum(Math.min(5, parseFloat(fillWidth) / 2));
    const alpha = decorationAlpha(v);

    const iconMarkup = ICONS[d.icon](mainColor);
    const decoMarkup = d.decorations
      .map((k) => '<g opacity="' + alpha + '">' + DECORATIONS[k](mainColor) + '</g>')
      .join('');

    // 分段式进度条刻度
    let ticks = '';
    for (let i = 1; i <= 9; i++) {
      const tx = fmtNum(90 + (300 * i / 10));
      ticks += '<line x1="' + tx + '" y1="138" x2="' + tx + '" y2="146" stroke="#ffffff" stroke-opacity="0.9" stroke-width="2"/>';
    }

    // 进度条末端圆点滑块
    const thumbX = fmtNum(90 + parseFloat(fillWidth));
    const thumbMarkup = v >= 1
      ? '<circle cx="' + thumbX + '" cy="142" r="7" fill="' + mainColor + '"/>' +
        '<circle cx="' + thumbX + '" cy="142" r="2.6" fill="#ffffff"/>'
      : '';

    // 情绪主题散落粒子，填充两侧留白
    const pts = [
      [46, 40, 2.6], [58, 100, 1.8], [40, 152, 2], [52, 212, 1.6],
      [434, 44, 2.4], [442, 102, 1.8], [436, 160, 2.2], [428, 216, 1.6],
      [80, 238, 1.8], [400, 238, 1.8], [30, 122, 1.6], [452, 128, 1.6],
    ];
    const particleCount = v >= 60 ? 12 : v < 40 ? 7 : 9;
    let particles = '';
    for (let i = 0; i < particleCount && i < pts.length; i++) {
      particles += '<circle cx="' + pts[i][0] + '" cy="' + pts[i][1] + '" r="' + pts[i][2] + '" fill="' + mainColor + '" opacity="' + fmtNum(0.10 + (i % 3) * 0.03) + '"/>';
    }

    // 情绪主题纹样 + 四角卷曲藤蔓 + 漂浮气泡（进一步丰富背景）
    const motif = emotionMotif(emotionType, mainColor);
    const swirls = cornerSwirls(mainColor);
    const bubblePts = [
      [92, 150, 7], [122, 40, 5], [362, 46, 6], [394, 158, 5],
      [102, 232, 5], [382, 230, 6], [152, 252, 4], [330, 246, 4],
    ];
    let bubbles = '';
    for (let i = 0; i < bubblePts.length; i++) {
      bubbles += '<circle cx="' + bubblePts[i][0] + '" cy="' + bubblePts[i][1] + '" r="' + bubblePts[i][2] + '" fill="' + rgba(color, 0.10) + '" stroke="' + rgba(color, 0.20) + '" stroke-width="1"/>';
    }

    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280" font-family="system-ui, -apple-system, sans-serif" role="img" aria-label="' + label + ' 情绪胶囊">' +
      '  <defs>' +
      '    <linearGradient id="capsule-bg-' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
      '      <stop offset="0%" stop-color="' + rgba(color, 0.12) + '"/>' +
      '      <stop offset="100%" stop-color="' + rgba(color, 0.03) + '"/>' +
      '    </linearGradient>' +
      '    <linearGradient id="capsule-bar-' + uid + '" x1="0" y1="0" x2="1" y2="0">' +
      '      <stop offset="0%" stop-color="' + rgba(color, 1) + '"/>' +
      '      <stop offset="100%" stop-color="' + rgba(color, 0.55) + '"/>' +
      '    </linearGradient>' +
      '    <radialGradient id="capsule-glow-' + uid + '" cx="50%" cy="50%" r="50%">' +
      '      <stop offset="0%" stop-color="' + rgba(color, 0.16) + '"/>' +
      '      <stop offset="65%" stop-color="' + rgba(color, 0.05) + '"/>' +
      '      <stop offset="100%" stop-color="' + rgba(color, 0) + '"/>' +
      '    </radialGradient>' +
      '    <pattern id="capsule-dots-' + uid + '" width="26" height="26" patternUnits="userSpaceOnUse">' +
      '      <circle cx="4" cy="4" r="1.3" fill="' + mainColor + '"/>' +
      '    </pattern>' +
      '    <clipPath id="capsule-clip-' + uid + '">' +
      '      <rect x="12" y="12" width="456" height="256" rx="120"/>' +
      '    </clipPath>' +
      '    <filter id="capsule-shadow-' + uid + '" x="-20%" y="-20%" width="140%" height="140%">' +
      '      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="' + mainColor + '" flood-opacity="0.18"/>' +
      '    </filter>' +
      '  </defs>' +
      '  <rect x="12" y="12" width="456" height="256" rx="120" fill="url(#capsule-bg-' + uid + ')" stroke="' + mainColor + '" stroke-width="2" filter="url(#capsule-shadow-' + uid + ')"/>' +
      '  <g clip-path="url(#capsule-clip-' + uid + ')">' +
      '    <rect x="22" y="22" width="436" height="236" rx="112" fill="none" stroke="' + rgba(color, 0.16) + '" stroke-width="1"/>' +
      '    <ellipse cx="240" cy="128" rx="210" ry="122" fill="url(#capsule-glow-' + uid + ')"/>' +
      '    <rect x="22" y="22" width="436" height="236" rx="112" fill="url(#capsule-dots-' + uid + ')" opacity="0.09"/>' +
      '    <g opacity="0.06" fill="none" stroke="' + mainColor + '" stroke-width="1">' +
      '      <circle cx="240" cy="62" r="52"/>' +
      '      <circle cx="240" cy="62" r="74"/>' +
      '    </g>' +
      motif +
      decoMarkup +
      swirls +
      bubbles +
      particles +
      '    <circle cx="240" cy="62" r="31" fill="none" stroke="' + rgba(color, 0.28) + '" stroke-width="1.5"/>' +
      '    <circle cx="240" cy="62" r="36" fill="none" stroke="' + rgba(color, 0.16) + '" stroke-width="1" stroke-dasharray="2 5" stroke-linecap="round"/>' +
      '    <circle cx="240" cy="62" r="24" fill="' + rgba(color, 0.15) + '"/>' +
      '    <g transform="translate(240,62)">' + iconMarkup + '</g>' +
      '    <text x="240" y="120" text-anchor="middle" font-size="30" font-weight="700" fill="#2d3436">' + label + '</text>' +
      '    <path d="M150 128 L202 128" stroke="' + rgba(color, 0.30) + '" stroke-width="1.5" stroke-linecap="round"/>' +
      '    <path d="M278 128 L330 128" stroke="' + rgba(color, 0.30) + '" stroke-width="1.5" stroke-linecap="round"/>' +
      '    <circle cx="240" cy="128" r="3" fill="' + mainColor + '" opacity="0.85"/>' +
      '    <rect x="90" y="137" width="300" height="10" rx="5" fill="#e9ecef"/>' +
      '    <rect x="90" y="137" width="' + fillWidth + '" height="10" rx="' + barRx + '" fill="url(#capsule-bar-' + uid + ')"/>' +
      ticks +
      thumbMarkup +
      '    <text x="240" y="190" text-anchor="middle" font-size="22" font-weight="700" fill="' + mainColor + '">' + displayIntensity + '%</text>' +
      '    <text x="240" y="212" text-anchor="middle" font-size="13" fill="#999">' + escapeXml(d.levelText) + '</text>' +
      '  </g>' +
      '</svg>'
    );
  }

  global.MoodCapsule = {
    generateCapsuleSvg: generateCapsuleSvg,
    suggestDesign: suggestDesign,
    intensityLevel: intensityLevel,
    clampIntensity: clampIntensity,
    normalizeColor: normalizeColor,
    hexToRgb: hexToRgb,
    ICON_KEYS: ICON_KEYS,
    DECORATION_KEYS: DECORATION_KEYS,
  };
})(window);
