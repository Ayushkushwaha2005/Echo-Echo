#!/usr/bin/env bash
# Bundles the ES-module sources into a single self-contained HTML file.
set -e
cd "$(dirname "$0")"
mkdir -p dist
OUT=dist/frisco.html
{
cat <<'EOF'
<title>Frisco Campus Ordering</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Manrope:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap">
<style>
EOF
cat styles/tokens.css
cat styles/app.css
echo "</style>"
echo '<div id="app"></div>'
echo '<script>'
sed 's/^export //' src/data.js
awk '/^import \{/{skip=1} skip && /from .\.\/data\.js.;$/{skip=0; next} skip{next} {print}' src/app.js
echo '</script>'
} > $OUT
echo "built $OUT"
