# Retomada: Orbi em C# (WPF)

Arquivo para abrir um chat novo no Claude Code e continuar daqui. Leia tudo antes de mexer.

## O que é
O **Orbi** é um notch para Windows 10/11, parecido com a Dynamic Island, no topo da tela (também pode ficar na esquerda ou na direita).
- **Fechado:** anel de bateria (com raio quando carrega) e hora.
- **Aberto** (mouse em cima): abas com avatar, música do Spotify, tarefas, calendário, notas, área de transferência, sistema, atalhos, clima, chat com IA e agentes do Claude Code.

Este repositório tem a **versão em C#/WPF (v2.0.0)**. É a versão de antes da reescrita em Rust.
- A versão em Rust (prévia) continua em outro repositório, **Halfszin/notch**, na pasta `tauri/`: motor em Rust e tela em HTML/CSS/JS no Tauri (WebView2). A antiga interface em Slint (pasta `rust/`) foi removida. É tocada em paralelo num outro chat.
- O dono fala português: responda, comente o código e escreva as mensagens de commit em português.

## Pedidos que valem sempre
- **Não mudar o visual nem as animações que já existem sem pedido.** Só acrescentar.
- Tudo em português, inclusive a interface.
- Mudanças pequenas e completas: código, testes e CI juntos.

## Estrutura
| Arquivo | O que faz |
|---|---|
| `App.xaml.cs` | Uma cópia só (`EventWaitHandle` "Orbi.ShowSettings"); abrir de novo mostra as configurações. `--startup` abre só o notch. |
| `MainWindow.xaml(.cs)` | O notch: abrir/fechar, abas, música, volume, bordas (Topo/Esquerda/Direita), sempre por cima. |
| `PageOrder.cs` | Páginas do notch como bolinhas (igual ao Rust): ordem e quais aparecem (`TabOrder` e `HiddenTabs` no config.json); rodinha do mouse e Ctrl+Alt+→/← trocam. |
| `SessionWindow.cs` | "Abrir terminal": acha a janela do terminal de cada sessão do Claude Code. |
| `SettingsWindow.xaml(.cs)` | Configurações: barra lateral com busca, cartões e chaves. |
| `Config.cs` | `%AppData%\Orbi\config.json`. A chave da API fica cifrada com DPAPI. |
| `Updater.cs` | Procura versão nova em **Halfszin/Orb** Releases (`latest`) ao abrir e a cada 4 h, baixa o `OrbiSetup.exe` e oferece "Reiniciar e atualizar". |
| `AvatarView.cs` + `web/` | Avatar renderizado no WebView2 (`web/avatar.bundle.js`; para gerar de novo: `cd web && npm install && npm run build`). |
| `BeatDetector.cs`, `SpectrumAnalyzer.cs`, `AudioWatcher.cs` | Reação às batidas e visualizador (NAudio, captura do som do PC). |
| `TodoPage`, `TaskParser.cs` | Tarefas com hora ("ligar pro banco às 15h") e lembretes. |
| `CalendarPage`, `NotesPage`, `ClipboardPage`, `SystemPage`, `ShortcutsPage`, `ShelfPage` | Abas. |
| `AiPage`, `AiChat.cs`, `ClaudeCli.cs` | Chat: usa a assinatura do Claude Code (CLI `claude`) e, se não tiver, a chave da API. |
| `AgentServer.cs`, `AgentHub.cs`, `HookInstaller.cs` | Agentes do Claude Code: hooks (`# orbi-hook`, curl para a porta 47821 com token do config.json) e pedidos de permissão no notch. |
| `UsageLog.cs` | Uso/limites do plano do Claude Code. |
| `Dictation.cs`, `Transcriber.cs`, `DictationText.cs` | Ditado: segure Ctrl direito, fale e solte. Whisper.net roda local. |
| `NotificationWatcher.cs` | WhatsApp/Discord no notch (lê as notificações do Windows). |
| `Weather.cs` | Clima (Open-Meteo). |
| `Sounds.cs`, `Theme.cs` | Sons e tema claro/escuro. |
| `installer.iss` | Instalador Inno Setup (`OrbiSetup.exe`). |
| `tests/` | Testes em console (`dotnet run --project tests`): batida, tarefas, hooks, agentes, ditado. |

Dados ficam em `%AppData%\Orbi`: `config.json`, `tarefas.json`, `notas.txt`, `atalhos.json`, `erros.log`.
- **Cuidado:** a versão em Rust lê os mesmos `tarefas.json`, `notas.txt` e `atalhos.json`, no mesmo formato (nomes em PascalCase: `Title`, `Due`, `Done`, `Notified`, `Name`, `Target`). Não mude esse formato sem combinar com o lado Rust.
- O Rust guarda as preferências dele em `rust-config.json`. O `config.json` é só do C#.

## Como sai uma versão
Todo push no `main` roda `.github/workflows/build.yml` no Windows. Ele:
1. faz os testes;
2. publica o .exe único;
3. abre o Orbi e tira prints (branch `ci-results`);
4. falha se o app fechou ou gravou `erros.log`;
5. gera o instalador;
6. publica em Releases com a tag `v<Version>` do `Orbi.csproj`.

**Para lançar uma versão nova, suba o `<Version>` no `Orbi.csproj`.** Sem isso, o mesmo release só é substituído e o atualizador não percebe nada.

Neste ambiente não há Windows nem .NET para rodar o app. Quem compila e testa é o CI, e os prints dele ficam no branch `ci-results`, que vale a pena conferir.

## Mudança de repositório (importante)
- Até a v2.0.0, o Orbi em C# publicava e se atualizava pelo **Halfszin/notch**. Agora o `Updater.cs` aponta para o **Halfszin/Orb**.
- Quem tem a v2.0.0 instalada pelo notch **não recebe sozinho** as versões novas daqui: precisa instalar uma vez o `OrbiSetup.exe` do Releases do Orb (a v2.0.1 em diante).
- O Orb tinha antes outro projeto (a esfera em Tauri). Ele continua no histórico do Git, antes do commit que trouxe o Orbi, e os releases antigos dele (`windows-v0.5.9`, `windows-latest`) continuam na página de Releases.

## Ideias pendentes (lista do dono)
- Trazer **todas** as funções do coucou (github.com/louis-cfm/coucou, pasta `windows/` é a versão Tauri para Windows). Só o código é MIT: o nome, o personagem Mochi, os sons e as imagens **não** podem ser copiados (`LICENSE-ASSETS.md`). Trazer as ideias, com o avatar e os sons do Orbi.
  - Já tem: permissão Permitir/Negar/Sempre, plano do Claude (5 h e semana), status das sessões, aviso de "terminou" com a última frase, Spotify com controles, ditado segurando Ctrl direito com atalhos de texto e estatísticas, WhatsApp (pelas notificações), chat pela assinatura do Claude Code, busca nas configurações, soltar arquivo no notch (prateleira).
  - Veio na 2.0.1: perguntas do Claude (AskUserQuestion) respondidas no notch, com uma ou várias opções e "Responder no terminal"; o cartão fecha se você responder no terminal; diff ao vivo (+N −M) de cada edição e o diff aberto na aba Agentes; hooks antigos ganham os eventos novos sozinhos ao abrir.
  - Veio na 2.0.2: atalhos Ctrl+Alt+A (pedido do Claude), Ctrl+Alt+T (terminal da sessão), Ctrl+Alt+→/← (páginas), Ctrl+Alt+S (sons); "Abrir terminal" (`SessionWindow.cs`: pela porta do curl acha o processo e sobe pelos pais até a janela) no cartão de "terminou", em "Responder no terminal" e clicando na sessão na aba Agentes.
  - Veio na 2.0.3: setas ‹ › dos lados das bolinhas; nova sessão do Claude Code na aba Agentes (pasta recente ou "Escolher pasta…" + pedido, abre o Windows Terminal ou o console rodando o `claude`); arrastar arquivo para o notch mostra "Ou numa sessão" e soltar ali cola o caminho no terminal da sessão.
  - Falta, em ordem de prioridade: trocar as teclas dos atalhos nas configurações (gravador, como no coucou), botão "abrir pasta de sons" (os sons próprios em `%AppData%\Orbi\sons` já funcionam), resumo da semana (recap.json, imagem para compartilhar), aba do GitHub (meus PRs, revisões, CI), chat com Markdown e outros provedores (OpenAI, Gemini, OpenRouter, Ollama/LM Studio), Outlook clássico (ler, regras, VIP), gravar chamada com transcrição e resumo, "OK Orbi" por voz, integrações (Stripe, Vercel, n8n, Notion, Cal.com, Resend), uso do Codex.
- Do Nusa e do coucou: letras sincronizadas e gradiente da capa já existem no Rust e podem vir para cá.
- Trocar a versão em C# pela de Rust quando a de Rust tiver tudo: instalador com o mesmo AppId.

## Commits
Mensagem em português, curta, no formato "Orbi X.Y.Z: o que mudou" quando sobe versão.
