# GamePilot Chrome Extension

### Abertura e login por personagem (ambiente local)

O launcher abre a aba Huntera, usa o login salvo no Gamepilot e seleciona o
personagem pelo cartão atual do jogo. Os scripts isolados carregam em
`document_end`, sem esperar todos os recursos da página. O painel informa cada
etapa. Uma conexão com vida zero não libera a atividade: a tela de morte permite
uma tentativa de Reviver por pedido e exige vida positiva antes de continuar.
As credenciais não são persistidas na extensão. Após atualizar o manifesto,
recarregue a extensão para aplicar o momento de carregamento dos scripts.

Extensão Manifest V3 do MVP. Ela conecta uma aba do Huntera ao GamePilot, envia heartbeat/telemetria à API e recebe comandos do painel.

Antes de retornar à cidade, a extensão ativa a aba do personagem e traz sua janela para frente, inclusive nos retornos automáticos. Isso permite que o loading avance mesmo quando a aba estava em segundo plano e ainda enviava telemetria. Se o Chrome recusar o foco, o retorno informa o erro antes de clicar para sair.

O service worker verifica a cada minuto o sinal local das abas do jogo. Após pelo menos 30 segundos sem sinal, ativa a aba e traz sua janela do Chrome para frente para tentar retomar o jogo suspenso em segundo plano. Cada aba tem um intervalo mínimo de dois minutos entre tentativas; abas fechadas ou que saíram do Huntera são removidas do monitor. O sinal local independe da conexão com a API e o monitor é preservado na sessão quando o worker adormece.

A conexão principal usa um único WebSocket autenticado no service worker para todas as abas Huntera. O canal envia keepalive a cada 20 segundos, reconecta com backoff e jitter e exige confirmação identificada de cada mensagem. Heartbeats são idempotentes e comandos usam entrega pelo menos uma vez com deduplicação por `commandId` na aba. Se a rede ou um proxy bloquear WebSockets, estado e comandos continuam pelo transporte HTTP de recuperação.

O adaptador Huntera detecta personagem, vocação, level, vida, mana, experiência, stamina, gold, capacidade, métricas do analisador e estado da caçada. Os comandos do MVP são iniciar, parar/retornar, abrir loja e destinar o loot conforme a política compartilhada pela conta: ignorar a coleta, guardar no armazém, vender no NPC ou comparar automaticamente com o leilão.

A configuração global de loot é aplicada antes de entrar em qualquer caçada e sincronizada por comando em todas as abas conectadas quando for alterada, inclusive durante uma caçada ativa.

As métricas do analisador usam os eventos 40/41 do WebSocket do jogo quando disponíveis, mesmo com a janela do analisador fechada. O heartbeat inclui `metrics.source: websocket`, início e duração, abates, XP e XP bruto, valor estimado do loot, gasto, saldo e taxas por hora. Inclui também `loot` e `supplies` (itemId, nome, quantidade e valor enviados pelo jogo) e `damageInput` (canal e valor). Taxas são calculadas usando a duração recebida; duração zero não gera taxas. Campos ausentes não são preenchidos com dados do DOM; a leitura da interface só é usada quando não há estado do analisador via socket. A reconexão limpa o analisador anterior. O valor do loot é uma avaliação, não uma confirmação de venda.

Se o botão não existir ou a tela não confirmar a ação, a extensão reporta falha para o painel e interrompe o ciclo.

## Carregar localmente

### Benchmark da aba (0.9.17)

No painel lateral, selecione **Executar benchmark nesta aba**. A extensão precisa
da permissão `debugger` e do Chrome 118 ou mais recente. Recarregue a extensão e
a página depois da atualização. O Chrome pode mostrar um aviso de depuração;
essa sessão é encerrada ao concluir ou cancelar. Se outra ferramenta já estiver
depurando a aba, o teste não começa nem remove a sessão existente.

O worker coleta `Performance.getMetrics` no `tabId` selecionado e alterna o modo
desligado → ligado → desligado. Cada fase tem 5 segundos de estabilização e 30
intervalos de aproximadamente 1 segundo (cerca de 2 minutos no total). Não há
coleta forçada de lixo. O toggle fica bloqueado durante o teste. O modo original
é restaurado ao concluir, cancelar ou falhar; a página mantém uma restauração
independente após 3 minutos ou ao recarregar se o worker for interrompido.

Mantenha a aba ativa e visível, o tamanho da janela e a caçada estáveis. Troca de
aba, mudança de visibilidade/tamanho, recarga, mudança de personagem ou início/fim
de caçada interrompem a comparação quando detectados na coleta. A geometria de
referência é obtida após o aviso de depuração do Chrome aparecer.

O relatório mostra **ocupação da thread principal**, calculada por
`100 × delta TaskDuration / delta Timestamp` com `timeTicks`, e média do heap JS
em MiB. O JSON inclui tempo de script, layout e recálculo de estilos em ms/s,
amostras de cada fase, condições e eventuais falhas de restauração. Não confundir
essas medidas com CPU de todos os threads, RAM total ou GPU. Outros contextos
que compartilham o renderer podem contribuir, e workers/frames em alvos separados
não são somados. Não atribui um PID exclusivo nem afirma isolamento total de RAM.

O modo ligado é comparado à média das duas fases desligadas. Diferença entre as
fases desligadas acima de 3 pontos percentuais ou 20% da média (o maior dos dois)
gera aviso de instabilidade; é uma heurística, não um teste estatístico. Uma
execução isolada não prova causalidade. Cancelamentos/falhas não geram comparação
concluída. Resultados ficam somente em `chrome.storage.session`, com exportação
JSON pelo painel; não são enviados à API. O último resultado substitui o anterior.

Referências: [Performance CDP](https://chromedevtools.github.io/devtools-protocol/1-3/Performance/),
[chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[ciclo de vida do worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

### Economia de energia (0.9.16)

O painel tem um toggle **Economia de energia** para a aba Huntera selecionada.
Começa desligado e salva a escolha por aba durante a sessão, inclusive após recarga.
Funciona independentemente da API. Após atualizar a extensão, recarregue o jogo para
carregar os dois scripts novos; o painel indica quando isso for necessário.

Ativado, oculta o canvas do cenário em `.viewport-host`, suprime suas chamadas de
desenho Canvas 2D/WebGL ao framebuffer da tela e simplifica efeitos dos slots.
Preserva ícones, controles, DOM, uploads de texturas e renderização WebGL em
framebuffers intermediários. Não altera RAF, timers, rede ou lógica do jogo.
Desativar remove a regra visual e restaura os métodos; o próximo desenho normal
atualiza o cenário. Não encerra a caçada nem exige nova conexão.

É uma otimização gráfica experimental: a preparação das cenas em JavaScript
continua acontecendo e os assets permanecem em memória. Não promete redução de
RAM nem uma porcentagem de CPU/GPU. Mudanças no renderer do Huntera ou caminhos
de desenho por extensões WebGL podem reduzir sua cobertura.

Validação local: `node --test tests/*.test.cjs`. Para medir no jogo, compare a
mesma aba/caçada por 60 segundos desligada, ligada e desligada novamente no
Gerenciador de Tarefas do Chrome (Shift+Esc), acompanhando CPU e memória pelo PID;
acompanhe GPU no Windows. Confirme eventos de XP/vida no GamePilot, retorno e
início de caçada, e restauração do cenário antes de habilitar nas outras contas.
Os testes automatizados não substituem essa validação no jogo ao vivo.

1. Abra `chrome://extensions`.
2. Ative o **Developer mode**.
3. Clique em **Load unpacked**.
4. Selecione esta pasta.
5. Abra ou recarregue uma aba em `https://huntera.com.br`.

Use somente um perfil de teste do Chrome. O token e as permissões são provisórios para desenvolvimento local.

## Usar com a API publicada

O login remoto agora também funciona com a API de produção. Cadastre a conta em
**Contas Huntera** no portal, escolha esta extensão e mantenha o Chrome aberto.
O agente verifica solicitações a cada minuto, abre a aba de login e seleciona o
personagem. A senha só permanece em memória durante a operação; não é gravada
no armazenamento da extensão. A identificação de personagens exige autenticação
com o login da solicitação para não associar uma sessão anterior à conta errada.

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

## Retomada após queda e server save

Durante uma caçada automatizada, a extensão preserva por aba o personagem e a configuração completa da atividade. Após confirmar a desconexão por 5 segundos, tenta selecionar novamente o personagem e retomar a atividade a cada 30 segundos, sem limite de tentativas. Uma conexão fechada que deixa a página travada provoca recarga após 60 segundos; o estado de recuperação sobrevive à recarga. As ações são reaplicadas e uma caçada já restaurada pelo jogo não é iniciada novamente. Grupos mantêm o papel de líder ou participante.

O comando Parar cancela a retomada. Trocar para outro personagem desativa a automação. A aba deve permanecer aberta, com a extensão ativa e a sessão do jogo autenticada; se o jogo exigir novo login, será necessário autenticar novamente. Os intervalos podem aumentar quando o navegador suspende a aba. A recuperação é reativa e também cobre manutenção fora do horário habitual de meio-dia.
