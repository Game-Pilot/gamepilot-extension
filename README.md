# GamePilot Chrome Extension

Extensão Manifest V3 do MVP. Ela conecta uma aba do Huntera ao GamePilot, envia heartbeat/telemetria à API e recebe comandos do painel.

O adaptador Huntera detecta personagem, vocação, level, vida, mana, experiência, stamina, gold, capacidade, métricas do analisador e estado da caçada. Os comandos do MVP são iniciar, parar/retornar, abrir loja e vender itens comuns quando o mercador estiver disponível. Itens de leilão não são enviados automaticamente.

Se o botão não existir ou a tela não confirmar a ação, a extensão reporta falha para o painel e interrompe o ciclo.

## Carregar localmente

1. Abra `chrome://extensions`.
2. Ative o **Developer mode**.
3. Clique em **Load unpacked**.
4. Selecione esta pasta.
5. Abra ou recarregue uma aba em `https://huntera.com.br`.

Use somente um perfil de teste do Chrome. O token e as permissões são provisórios para desenvolvimento local.

## Usar com a API publicada

Esta versão aponta para `https://gamepilot-api-production.up.railway.app`. Depois de atualizar os arquivos da extensão, abra `chrome://extensions`, clique em **Reload** e faça o vínculo novamente se o dispositivo anterior estiver revogado.

Para desenvolvimento local, altere a constante `API` no `service-worker.js` para `http://127.0.0.1:4317` e mantenha a permissão local no `manifest.json`.
