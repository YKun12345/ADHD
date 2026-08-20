from pathlib import Path
import re


BASE = Path(r"D:\ADHD_Web\fmri-findviz-main\findviz")
MAIN_ROUTE = BASE / "routes" / "main.py"
INDEX_TEMPLATE = BASE / "templates" / "index.html"
ANALYSIS_TEMPLATE = BASE / "templates" / "analysis.html"
STYLES = BASE / "static" / "css" / "styles.css"


def replace_once(text: str, old: str, new: str) -> str:
    if old not in text:
        raise ValueError(f"Target text not found: {old[:60]!r}")
    return text.replace(old, new, 1)


def patch_main_route() -> None:
    text = MAIN_ROUTE.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "from flask import Blueprint, render_template",
        "from flask import Blueprint, render_template, request",
    )
    old_index = """@main_bp.route('/')\ndef index():\n    \"\"\"Serve the main application page.\"\"\"\n    return render_template('index.html')\n"""
    new_index = """@main_bp.route('/')\ndef index():\n    \"\"\"Serve the main application page.\"\"\"\n    embed_mode = request.args.get('embed') == '1'\n    return render_template(\n        'index.html',\n        embed_mode=embed_mode,\n        patient_name=request.args.get('patient_name', ''),\n        patient_email=request.args.get('patient_email', ''),\n        return_url=request.args.get('return_url', ''),\n    )\n"""
    text = replace_once(text, old_index, new_index)

    new_analysis = """    return render_template(\n        'analysis.html', \n        plot_type=plot_type,\n        analysis=analysis,\n        embed_mode=request.args.get('embed') == '1',\n        patient_name=request.args.get('patient_name', ''),\n        patient_email=request.args.get('patient_email', ''),\n        return_url=request.args.get('return_url', ''),\n    )\n"""
    analysis_pattern = re.compile(
        r"    return render_template\(\s*'analysis\.html',\s*plot_type=plot_type,\s*analysis=analysis\s*\)\s*",
        re.MULTILINE,
    )
    if not analysis_pattern.search(text):
        raise ValueError("Could not locate analysis render_template block.")
    text = analysis_pattern.sub(new_analysis, text, count=1)
    MAIN_ROUTE.write_text(text, encoding="utf-8")


EMBED_BLOCK = """{% if embed_mode %}
  <div class="embed-topbar">
    <div class="embed-brand">
      <span class="embed-brand-pill">智绘脑图</span>
      <span class="embed-brand-title">脑影像可视化工作台</span>
    </div>
    <div class="embed-patient">
      <span>当前患者：{{ patient_name or '未选择' }}</span>
      {% if patient_email %}
      <span class="embed-patient-email">{{ patient_email }}</span>
      {% endif %}
    </div>
    {% if return_url %}
    <a class="embed-return" href="{{ return_url }}" target="_top">返回研究平台</a>
    {% endif %}
  </div>
  {% endif %}
"""


def patch_template(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = replace_once(text, "<body>", "<body class=\"{{ 'embed-mode' if embed_mode else '' }}\">")
    text = replace_once(text, "<body class=\"{{ 'embed-mode' if embed_mode else '' }}\">", "<body class=\"{{ 'embed-mode' if embed_mode else '' }}\">\n" + EMBED_BLOCK)
    path.write_text(text, encoding="utf-8")


EMBED_STYLES = """

/* Embedded Mode */
body.embed-mode {
  background: #F8FAFC;
}

.embed-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.5rem;
  background: linear-gradient(135deg, #E8F1FF 0%, #FFFFFF 100%);
  border-bottom: 1px solid rgba(191, 219, 254, 0.7);
  position: sticky;
  top: 0;
  z-index: 20;
}

.embed-brand {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  flex-wrap: wrap;
}

.embed-brand-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.38rem 0.82rem;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.1);
  color: #1D4ED8;
  font-size: 0.88rem;
  font-weight: 700;
}

.embed-brand-title {
  font-size: 1rem;
  font-weight: 700;
  color: #0F172A;
}

.embed-patient {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  color: #475569;
  font-size: 0.9rem;
  line-height: 1.5;
}

.embed-patient-email {
  color: #64748B;
  font-size: 0.82rem;
}

.embed-return {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.7rem 1rem;
  border-radius: 12px;
  border: 1px solid #BFDBFE;
  color: #1E3A8A;
  background: #FFFFFF;
  font-size: 0.9rem;
  font-weight: 700;
  text-decoration: none;
}

.embed-return:hover {
  background: #EFF6FF;
  text-decoration: none;
}

body.embed-mode .jumbotron {
  margin-top: 1rem;
  padding: 1.8rem 1.4rem;
  border-radius: 22px;
}

body.embed-mode .jumbotron h1 {
  font-size: 1.9rem;
}

body.embed-mode #parent-container {
  margin-top: 1rem !important;
  padding-left: 0.75rem;
  padding-right: 0.75rem;
}
"""


def patch_styles() -> None:
    text = STYLES.read_text(encoding="utf-8")
    if "/* Embedded Mode */" not in text:
        text += EMBED_STYLES
    STYLES.write_text(text, encoding="utf-8")


def main() -> None:
    patch_main_route()
    patch_template(INDEX_TEMPLATE)
    patch_template(ANALYSIS_TEMPLATE)
    patch_styles()
    print("findviz embed mode patched successfully.")


if __name__ == "__main__":
    main()
