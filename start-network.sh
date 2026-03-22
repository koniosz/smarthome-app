#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  Smart Home Manager — tryb sieciowy (LAN)
#  Buduje frontend i uruchamia backend na wszystkich interfejsach.
#  Zespół otwiera http://<IP-tego-maca>:4001
# ─────────────────────────────────────────────────────────────────
export PATH="/Users/konradsz/.nvm/versions/node/v24.13.0/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Kolory ────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BOLD}🏠 Smart Home Manager — tryb sieciowy${NC}"
echo "──────────────────────────────────────────"

# ── 1. Instalacja zależności ──────────────────────────────────────
echo -e "${CYAN}📦 Sprawdzam zależności...${NC}"
cd "$DIR/backend"  && npm install --ignore-scripts --silent 2>&1 | tail -1
cd "$DIR/frontend" && npm install --ignore-scripts --silent 2>&1 | tail -1

# ── 2. Budowanie frontendu ────────────────────────────────────────
echo -e "${CYAN}🔨 Buduję frontend...${NC}"
cd "$DIR/frontend"
node node_modules/.bin/vite build 2>&1 | grep -E "built|error|warning|✓|vite" | tail -5

if [ ! -d "$DIR/frontend/dist" ]; then
  echo -e "❌ Błąd budowania frontendu. Sprawdź logi powyżej."
  exit 1
fi
echo -e "${GREEN}✓ Frontend zbudowany${NC}"

# ── 3. Wykrycie lokalnego IP ──────────────────────────────────────
LOCAL_IP=$(node -e "
const os = require('os');
const ifaces = os.networkInterfaces();
for (const name of Object.keys(ifaces)) {
  for (const i of ifaces[name]) {
    if (i.family === 'IPv4' && !i.internal) { process.stdout.write(i.address); process.exit(0); }
  }
}
process.stdout.write('localhost');
" 2>/dev/null)

# ── 4. Start backendu ─────────────────────────────────────────────
echo -e "${CYAN}🚀 Uruchamiam backend...${NC}"
cd "$DIR/backend"
node node_modules/.bin/tsx src/index.ts &
BACKEND_PID=$!

sleep 2

# ── 5. Sprawdzenie czy działa ─────────────────────────────────────
if ! kill -0 $BACKEND_PID 2>/dev/null; then
  echo "❌ Backend nie uruchomił się. Sprawdź logi."
  exit 1
fi

# ── 6. Podsumowanie ───────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✅ Smart Home Manager działa!${NC}"
echo "──────────────────────────────────────────"
echo -e "  ${BOLD}Twój komputer:${NC}  http://localhost:4001"
if [ "$LOCAL_IP" != "localhost" ]; then
  echo -e "  ${BOLD}Sieć LAN:${NC}       ${YELLOW}http://${LOCAL_IP}:4001${NC}  ← wyślij zespołowi"
fi
echo ""
echo -e "  ${CYAN}Dane logowania (domyślne):${NC}"
echo "    Login:  ks@smarthomecenter.pl"
echo "    Hasło:  admin123"
echo ""
echo -e "  ${CYAN}Aby zatrzymać: Ctrl+C${NC}"
echo "──────────────────────────────────────────"
echo ""

# Otwórz lokalnie
open "http://localhost:4001" 2>/dev/null || true

trap "echo ''; echo '🛑 Zatrzymuję...'; kill $BACKEND_PID 2>/dev/null; exit 0" INT TERM
wait $BACKEND_PID
