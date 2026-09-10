# GamePilot Chrome Extension

Extensão Manifest V3 do MVP. Ela conecta uma aba do Huntera ao GamePilot, envia heartbeat/telemetria à API e recebe comandos do painel.

A conexão principal usa um único WebSocket autenticado no service worker para todas as abas Huntera. O canal envia keepalive a cada 20 segundos, reconecta com backoff e jitter e exige confirmação identificada de cada mensagem. Heartbeats são idempotentes e comandos usam entrega pelo menos uma vez com deduplicação por `commandId` na aba. Se a rede ou um proxy bloquear WebSockets, estado e comandos continuam pelo transporte HTTP de recuperação.

O adaptador Huntera detecta personagem, vocação, level, vida, mana, experiência, stamina, gold, capacidade, métricas do analisador e estado da caçada. Os comandos do MVP são iniciar, parar/retornar, abrir loja e destinar o loot conforme a política compartilhada pela conta: ignorar a coleta, guardar no armazém, vender no NPC ou comparar automaticamente com o leilão.

A configuração global de loot é aplicada antes de entrar em qualquer caçada e sincronizada por comando em todas as abas conectadas quando for alterada, inclusive durante uma caçada ativa.

As métricas do analisador usam os eventos 40/41 do WebSocket do jogo quando disponíveis, mesmo com a janela do analisador fechada. O heartbeat inclui `metrics.source: websocket`, início e duração, abates, XP e XP bruto, valor estimado do loot, gasto, saldo e taxas por hora. Inclui também `loot` e `supplies` (itemId, nome, quantidade e valor enviados pelo jogo) e `damageInput` (canal e valor). Taxas são calculadas usando a duração recebida; duração zero não gera taxas. Campos ausentes não são preenchidos com dados do DOM; a leitura da interface só é usada quando não há estado do analisador via socket. A reconexão limpa o analisador anterior. O valor do loot é uma avaliação, não uma confirmação de venda.

Se o botão não existir ou a tela não confirmar a ação, a extensão reporta falha para o painel e interrompe o ciclo.

## Carregar localmente

1. Abra `chrome://extensions`.
2. Ative o **Developer mode**.
3. Clique em **Load unpacked**.
4. Selecione esta pasta.
5. Abra ou recarregue uma aba em `https://huntera.com.br`.

Use somente um perfil de teste do Chrome. O token e as permissões são provisórios para desenvolvimento local.

## Usar com a API publicada

Esta versão aponta para `https://gamepilot-api.iancosta.dev`. Depois de atualizar os arquivos da extensão, abra `chrome://extensions`, clique em **Reload** e faça o vínculo novamente se o dispositivo anterior estiver revogado.

Para desenvolvimento local, altere a constante `API` no `service-worker.js` para `http://127.0.0.1:4317` e mantenha a permissão local no `manifest.json`.

## Versionamento automático

O workflow `Test and version extension` testa PRs e pushes na main. Quando arquivos da extensão mudam sem aumento de versão, ele incrementa o patch do manifest e envia um commit automático. Bumps manuais são preservados; regressões de versão falham. Alterações apenas em documentação, testes e ferramentas não exigem bump.

Para fazer o bump antes do push, execute `node scripts/version.cjs --bump` na pasta da extensão e inclua o manifest no commit. O workflow precisa de Actions habilitado e permissão de escrita na main para o GITHUB_TOKEN. Falhas de testes ou proteção de branch interrompem o processo e aparecem no Actions. O commit do bot não dispara outros workflows de push; uma futura publicação via Actions deve acontecer neste mesmo workflow, após o versionamento.

## Medição própria experimental

A sidebar também exibe `observedAnalyzer`, enviado no heartbeat separadamente de `metrics`. Conta eventos ao vivo de XP (30, filtrado por playerId), dano recebido (20, filtrado por targetId) e diferenças positivas do bestiário (9). Abates são parciais: uma criatura sem baseline ou uma mudança de etapa não é extrapolada. Efeitos visuais do dano não são interpretados como canais oficiais. Inventário não é convertido em loot/consumo por não distinguir transferências e vendas.

A coleta ignora eventos em cache dos snapshots, deduplica sequências e reinicia ao reconectar ou mudar startedAt da sessão. Só acumula enquanto o adaptador identifica caçada/retorno. Duração e XP/h cobrem o período observado, não necessariamente a sessão inteira. Recarregar descarta a coleta local; o heartbeat contém apenas o último estado recebido.

Ao receber dois frames oficiais 41 da mesma sessão, a comparação calcula deltas de XP, abates e dano entre o primeiro frame e o atual, tanto para os totais próprios quanto para os oficiais. A ordem de entrega dos eventos pode causar diferenças na fronteira do intervalo; os resultados são experimentais. Para validar, carregue a nova versão e use uma conta com analisador durante uma caçada. Não compare totais de personagens ou períodos diferentes.

## Validação e dano causado — 07/09/2026

Holyae, intervalo oficial 17:33:59.046–17:38:33.193 UTC: 74.410 XP, 8.344 dano recebido e 67 abates, iguais nos deltas próprios e oficiais. Uma leitura anterior apresentou 64/65 abates; a seguinte convergiu. Isso valida esta amostra, não todos os cenários ou a cobertura de mudanças de etapa do bestiário. Evidência local: .local/research/analyzer-validation-20260907.json na raiz do workspace.

A medição própria agora soma dano causado no evento 20 quando attackerId é o jogador e targetId é outro alvo. DPS usa todo o período observado, não apenas tempo atacando. Eventos 24 com id do jogador, kind spell e spellId contam usos por magia, inclusive magias de suporte. Não representam acertos nem dano por magia.

Os eventos reais mostraram hits antes das notificações de magia e efeitos blood tanto em ataques comuns quanto em strong-ethereal-spear. Portanto todo dano causado permanece sem atribuição; não usamos proximidade temporal nem efeito visual para inventar uma associação. Não há total oficial de dano causado no frame 41 observado para comparação. Novos campos exigem carregar a extensão atualizada.

## Recordes e tempo por faixa de vida

A sidebar registra a menor vida em HP, a menor porcentagem de vida e o maior dano de um único acerto próprio. O gráfico mostra o tempo e sua porcentagem em dez faixas de 10%, com 100% separado. Integra a última vida válida até o próximo evento ao vivo durante a caçada/retorno; exclui intervalos inativos ou sem vida conhecida e não avança apenas por abrir o painel. Nova sessão/reconexão reinicia a medição. Fechar a sidebar preserva os dados na aba; recarregar a aba descarta a coleta local.
