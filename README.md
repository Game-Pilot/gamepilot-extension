# GamePilot Chrome Extension

Extensão Manifest V3 do MVP. Ela valida a comunicação com uma aba do Huntera, lê URL/título, envia heartbeat à API e recebe comandos do painel.

O adaptador Huntera detecta personagem, vocação, level, vida, mana, experiência, stamina e se a aba está em uma caçada. O primeiro comando real é open-store: ele clica no botão público da loja, confirma a janela e não vende itens.

Se o personagem estiver em caçada, se o botão não existir ou se a janela não abrir, a extensão reporta falha e não continua.

## Carregar localmente

1. Abra `chrome://extensions`.
2. Ative o **Developer mode**.
3. Clique em **Load unpacked**.
4. Selecione esta pasta.
5. Abra ou recarregue uma aba em `https://huntera.com.br`.

Use somente um perfil de teste do Chrome. O token e as permissões são provisórios para desenvolvimento local.
