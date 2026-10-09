# -*- coding: utf-8 -*-
"""情绪胶囊生成组件（Emotion Capsule SVG Generator）

根据用户的情绪类型、情绪强度和选择的颜色，生成一个个性化的可视化情绪胶囊 SVG 卡片。

输入参数：
    emotion_type (str)：情绪类型名称，如「焦虑」「开心」「悲伤」「愤怒」等
    intensity (int/float/str, 0-100)：情绪强度百分比，0 为完全平静，100 为情绪极度强烈
    color (str)：用户选择的主题颜色（十六进制色值），如 #FF6B6B

输出：
    一个独立的、可渲染的 SVG 情绪胶囊图形（字符串）。

纯 SVG 输出，无外部依赖。
"""

from __future__ import annotations

__all__ = ["generate_capsule_svg", "main", "clamp_intensity", "intensity_level"]


def _hex_to_rgb(color: str) -> tuple:
    """将十六进制色值解析为 (r, g, b) 三元组，非法输入回退到默认主色 #FF6B6B。"""
    c = (color or "").strip().lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        c = "FF6B6B"
    try:
        return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
    except ValueError:
        return (255, 107, 107)


def _rgba(color: str, alpha: float) -> str:
    """返回 rgba(r, g, b, alpha) 字符串。"""
    r, g, b = _hex_to_rgb(color)
    return "rgba({}, {}, {}, {})".format(r, g, b, format(alpha, "g"))


def _normalize_color(color: str) -> str:
    """将任意合法/非法色值归一化为规范的 #RRGGBB 大写形式。"""
    r, g, b = _hex_to_rgb(color)
    return "#{:02X}{:02X}{:02X}".format(r, g, b)


def _escape(text: str) -> str:
    """转义 XML 特殊字符，避免破坏 SVG 结构。"""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def clamp_intensity(value) -> float:
    """将强度 clamp 到 0-100 区间，非数字输入按 0 处理。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = 0.0
    return max(0.0, min(100.0, v))


def intensity_level(intensity) -> str:
    """根据强度百分比映射强度等级。"""
    v = int(round(clamp_intensity(intensity)))
    if v <= 24:
        return "情绪平静"
    if v <= 49:
        return "情绪轻微"
    if v <= 79:
        return "情绪明显"
    return "情绪强烈"


def generate_capsule_svg(emotion_type: str = "", intensity=0, color: str = "#FF6B6B") -> str:
    """生成情绪胶囊 SVG 卡片。

    Args:
        emotion_type: 情绪类型名称。
        intensity: 情绪强度百分比（0-100）。
        color: 主题颜色（十六进制色值）。

    Returns:
        完整的 SVG 字符串。
    """
    v = clamp_intensity(intensity)
    display_intensity = int(round(v))
    level = intensity_level(v)
    main_color = _normalize_color(color)

    # 底轨总宽 300px，填充宽度 = 300 * intensity / 100
    fill_width = round(300 * v / 100.0, 2)
    bar_rx = min(6, fill_width / 2)

    label = _escape(emotion_type) or "情绪"

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280" font-family="system-ui, -apple-system, sans-serif" role="img" aria-label="{label} 情绪胶囊">
  <defs>
    <linearGradient id="capsule-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{_rgba(color, 0.12)}"/>
      <stop offset="100%" stop-color="{_rgba(color, 0.03)}"/>
    </linearGradient>
    <linearGradient id="capsule-bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="{_rgba(color, 1.0)}"/>
      <stop offset="100%" stop-color="{_rgba(color, 0.55)}"/>
    </linearGradient>
    <filter id="capsule-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="{main_color}" flood-opacity="0.18"/>
    </filter>
  </defs>

  <!-- 胶囊主体 -->
  <rect x="12" y="12" width="456" height="256" rx="120" fill="url(#capsule-bg)" stroke="{main_color}" stroke-width="2" filter="url(#capsule-shadow)"/>

  <!-- 顶部：心形图标 + 主色 15% 透明光晕 -->
  <circle cx="240" cy="72" r="36" fill="{_rgba(color, 0.15)}"/>
  <g transform="translate(240,72) scale(1.25) translate(-12,-12)">
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="{main_color}"/>
  </g>

  <!-- 中部核心：情绪类型名称 -->
  <text x="240" y="146" text-anchor="middle" font-size="30" font-weight="700" fill="#212529">{label}</text>

  <!-- 进度条：灰色底轨 + 主色渐变填充 -->
  <rect x="90" y="168" width="300" height="12" rx="6" fill="#e9ecef"/>
  <rect x="90" y="168" width="{format(fill_width, 'g')}" height="12" rx="{format(bar_rx, 'g')}" fill="url(#capsule-bar)"/>

  <!-- 底部：强度百分比数字 + 等级文字 -->
  <text x="240" y="216" text-anchor="middle" font-size="22" font-weight="700" fill="{main_color}">{display_intensity}%</text>
  <text x="240" y="242" text-anchor="middle" font-size="13" fill="#6c757d">{level}</text>
</svg>'''


def main(emotion_type: str = "", intensity=0, color: str = "#FF6B6B") -> dict:
    """Dify 代码节点风格入口，返回可被下游引用的字典。"""
    return {"svg": generate_capsule_svg(emotion_type, intensity, color)}


if __name__ == "__main__":
    import sys

    samples = [
        ("焦虑", 72, "#FF6B6B"),
        ("开心", 90, "#FFA94D"),
        ("悲伤", 30, "#4DABF7"),
        ("愤怒", 5, "#F06595"),
    ]
    for et, it, c in samples:
        out = main(et, it, c)
        print("情绪类型={}, 强度={}, 颜色={}, 等级={}".format(et, it, c, intensity_level(it)))
        print(out["svg"])
        print()

    if "--write" in sys.argv:
        with open("emotion_capsule.svg", "w", encoding="utf-8") as f:
            f.write(main("焦虑", 72, "#FF6B6B")["svg"])
        print("已写入 emotion_capsule.svg")
