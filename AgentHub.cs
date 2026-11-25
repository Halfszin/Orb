using System.IO;
using System.Text.Json.Nodes;

namespace Orbi;

// Estado das sessões do Claude Code a partir dos eventos dos hooks, e as decisões de permissão.
public sealed class AgentHub
{
    public sealed class Session
    {
        public string Id = "", Project = "", Status = "", Cwd = "";
        public bool Busy;
        public DateTime Updated;
        public readonly List<FileEdit> Edits = new(); // diff ao vivo, como no coucou
    }

    /// <summary>Uma edição de arquivo: linhas começando com '+', '-' ou ' ' (vazio se grande demais).</summary>
    public sealed record FileEdit(string File, int Added, int Removed, string[] Lines);

    /// <summary>Uma pergunta do AskUserQuestion: o texto, as opções e se aceita várias.</summary>
    public sealed record Question(string Text, string[] Options, string[] Descriptions, bool Multi);

    public sealed class Permission
    {
        public string Project = "", Tool = "", Detail = "", What = "", Code = "", SessionId = "";
        public JsonNode? Suggestions, Input;
        public List<Question>? Questions; // não-nulo: é uma pergunta do Claude, não um pedido de permissão
        public readonly TaskCompletionSource<string> Answer = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public sealed record PlanWindow(double UsedPct, DateTimeOffset ResetsAt);
    public sealed record PlanUsage(PlanWindow? FiveHour, PlanWindow? SevenDay);

    public readonly Dictionary<string, Session> Sessions = new();
    public readonly List<Permission> Pending = new();
    public PlanUsage? Plan { get; private set; }
    public bool Busy => Sessions.Values.Any(s => s.Busy);
    public string? LastSessionId { get; private set; } // a última sessão que mandou evento ("Abrir terminal" sem pedido aberto)

    public event Action? Changed;
    public event Action<string, string>? Finished;         // projeto, última mensagem do Claude
    public event Action<string, string>? NeedsYou;         // projeto, mensagem
    public event Action<Permission>? PermissionAsked;

    public static readonly TimeSpan DecisionTimeout = TimeSpan.FromSeconds(110);

    /// <summary>Um evento chegou (na thread da interface). Devolve o texto de resposta para o hook.</summary>
    public async Task<string> Handle(string evt, JsonObject p)
    {
        if (evt == "statusline")
        {
            if (ParsePlan(p) is { } plan) Plan = Merge(Plan, plan);
            Changed?.Invoke();
            return StatusLine(p, Plan);
        }

        string id = Str(p, "session_id") ?? "?";
        string project = Path.GetFileName(Str(p, "cwd")?.TrimEnd('/', '\\') ?? "") is { Length: > 0 } name ? name : "Claude Code";
        if (!Sessions.TryGetValue(id, out var s)) Sessions[id] = s = new Session { Id = id };
        s.Project = project;
        s.Cwd = Str(p, "cwd") ?? s.Cwd;
        s.Updated = DateTime.Now;
        LastSessionId = id;
        string? answer = null;
        switch (evt)
        {
            case "SessionStart": s.Status = "Começou"; s.Busy = false; break;
            case "UserPromptSubmit": s.Status = "Pensando…"; s.Busy = true; break;
            case "PreToolUse": s.Status = Describe(Str(p, "tool_name") ?? "", p["tool_input"]); s.Busy = true; break;
            case "PostToolUse":
                s.Busy = true;
                // A ferramenta rodou: o que estava pendente nesta sessão foi respondido no terminal.
                foreach (var stale in Pending.Where(x => x.SessionId == id)) stale.Answer.TrySetResult("");
                if (ParseEdit(Str(p, "tool_name") ?? "", p["tool_input"], p["tool_response"]) is { } edit)
                {
                    s.Edits.Add(edit);
                    if (s.Edits.Count > 50) s.Edits.RemoveAt(0);
                    s.Status = $"Editou {edit.File} +{edit.Added} −{edit.Removed}";
                }
                break;
            case "Notification":
                s.Status = "Esperando você"; s.Busy = false;
                NeedsYou?.Invoke(project, Str(p, "message") ?? "O Claude precisa de você");
                break;
            case "Stop":
                s.Status = "Terminou"; s.Busy = false;
                Finished?.Invoke(project, Str(p, "last_assistant_message") ?? LastAssistantText(Str(p, "transcript_path")) ?? "");
                break;
            case "SessionEnd": Sessions.Remove(id); break;
            case "PermissionRequest":
                s.Status = "Pedindo permissão"; s.Busy = false;
                string tool = Str(p, "tool_name") ?? "";
                var input = p["tool_input"];
                var questions = tool == "AskUserQuestion" ? ParseQuestions(input) : null;
                var perm = new Permission
                {
                    Project = project, Tool = tool, SessionId = id, Input = input?.DeepClone(), Questions = questions, Detail = Describe(tool, input, full: true), Suggestions = p["permission_suggestions"]?.DeepClone(),
                    What = questions != null ? "Claude Code tem uma pergunta" : tool switch
                    {
                        "Bash" or "PowerShell" => "Claude Code quer rodar um comando",
                        "Edit" or "MultiEdit" or "Write" or "NotebookEdit" => "Claude Code quer mexer num arquivo",
                        "WebFetch" or "WebSearch" => "Claude Code quer acessar a web",
                        _ => $"Claude Code quer usar {tool}",
                    },
                    Code = Str(input, "command") ?? Str(input, "file_path") ?? Str(input, "url") ?? Str(input, "query") ?? tool,
                };
                Pending.Add(perm);
                Changed?.Invoke();
                PermissionAsked?.Invoke(perm);
                // Sem resposta a tempo: devolve vazio e o Claude Code pergunta no terminal, como sempre.
                var done = await Task.WhenAny(perm.Answer.Task, Task.Delay(DecisionTimeout));
                Pending.Remove(perm);
                answer = done == perm.Answer.Task ? perm.Answer.Task.Result : "";
                if (Sessions.TryGetValue(id, out var still)) { still.Status = answer.Contains("\"deny\"") ? "Permissão negada" : "Trabalhando"; still.Busy = !answer.Contains("\"deny\""); }
                break;
        }
        // Sessões paradas há muito tempo somem da lista.
        foreach (var old in Sessions.Values.Where(x => !x.Busy && DateTime.Now - x.Updated > TimeSpan.FromMinutes(30)).ToList()) Sessions.Remove(old.Id);
        Changed?.Invoke();
        return answer ?? "{}";
    }

    public static void Decide(Permission perm, string choice) => perm.Answer.TrySetResult(PermissionResponse(choice, perm.Suggestions));

    public static string PermissionResponse(string choice, JsonNode? suggestions)
    {
        var decision = new JsonObject { ["behavior"] = choice == "deny" ? "deny" : "allow" };
        if (choice == "deny") decision["message"] = "Negado pelo Orbi";
        if (choice == "always" && suggestions is JsonArray { Count: > 0 }) decision["updatedPermissions"] = suggestions.DeepClone();
        return new JsonObject { ["hookSpecificOutput"] = new JsonObject { ["hookEventName"] = "PermissionRequest", ["decision"] = decision } }.ToJsonString();
    }

    /// <summary>Responde a pergunta: o Claude Code recebe a mesma entrada com "answers" (texto da pergunta → opção, ou lista de opções).</summary>
    public static void AnswerQuestions(Permission perm, IReadOnlyList<string[]> picked) => perm.Answer.TrySetResult(QuestionResponse(perm, picked) ?? "");

    public static string? QuestionResponse(Permission perm, IReadOnlyList<string[]> picked)
    {
        if (perm.Questions is not { } qs || perm.Input is not JsonObject input || picked.Count != qs.Count) return null;
        var answers = new JsonObject();
        for (int i = 0; i < qs.Count; i++)
        {
            // Só aceita opções que o Claude ofereceu; nada inventado vai para a resposta.
            if (picked[i].Length == 0 || picked[i].Any(o => !qs[i].Options.Contains(o)) || (!qs[i].Multi && picked[i].Length != 1)) return null;
            answers[qs[i].Text] = qs[i].Multi ? new JsonArray(picked[i].Select(o => (JsonNode)JsonValue.Create(o)!).ToArray()) : picked[i][0];
        }
        var updated = input.DeepClone().AsObject();
        updated["answers"] = answers;
        var decision = new JsonObject { ["behavior"] = "allow", ["updatedInput"] = updated };
        return new JsonObject { ["hookSpecificOutput"] = new JsonObject { ["hookEventName"] = "PermissionRequest", ["decision"] = decision } }.ToJsonString();
    }

    /// <summary>As perguntas, se o notch consegue mostrar todas como opções; senão null e fica para o terminal.</summary>
    public static List<Question>? ParseQuestions(JsonNode? input)
    {
        if (input?["questions"] is not JsonArray arr || arr.Count == 0) return null;
        var list = new List<Question>();
        foreach (var q in arr)
        {
            string text = Str(q, "question") ?? "";
            var opts = (q?["options"] as JsonArray ?? new JsonArray()).Where(o => Str(o, "label") is { Length: > 0 }).ToList();
            if (text.Length == 0 || opts.Count < 2) return null;
            bool multi = q?["multiSelect"] is JsonValue mv && mv.TryGetValue(out bool m) && m;
            list.Add(new Question(text, opts.Select(o => Str(o, "label")!).ToArray(), opts.Select(o => Str(o, "description") ?? "").ToArray(), multi));
        }
        return list;
    }

    const int MaxDiffChars = 200 * 1024, MaxDiffLines = 4000;

    /// <summary>O diff de um Edit/MultiEdit/Write. Usa o structuredPatch que o Claude Code devolve; sem ele, o antes/depois da entrada.</summary>
    public static FileEdit? ParseEdit(string tool, JsonNode? input, JsonNode? response)
    {
        if (tool is not ("Edit" or "MultiEdit" or "Write")) return null;
        string? path = Str(input, "file_path");
        if (path == null) return null;
        var lines = new List<string>();
        if (response?["structuredPatch"] is JsonArray { Count: > 0 } hunks)
        {
            foreach (var h in hunks)
            {
                if (lines.Count > 0) lines.Add(" …");
                foreach (var l in h?["lines"] as JsonArray ?? new JsonArray())
                    if (l is JsonValue v && v.TryGetValue(out string? t)) lines.Add(t);
            }
        }
        else if (tool == "Write") lines.AddRange(Split(Str(input, "content")).Select(l => "+" + l));
        else
        {
            var edits = tool == "Edit" ? new JsonArray(input!.DeepClone()) : input?["edits"] as JsonArray ?? new JsonArray();
            foreach (var e in edits)
            {
                if (lines.Count > 0) lines.Add(" …");
                lines.AddRange(Split(Str(e, "old_string")).Select(l => "-" + l));
                lines.AddRange(Split(Str(e, "new_string")).Select(l => "+" + l));
            }
        }
        int added = lines.Count(l => l.StartsWith('+')), removed = lines.Count(l => l.StartsWith('-'));
        if (added == 0 && removed == 0) return null;
        // Grande demais: guarda só as contas, como o coucou.
        bool tooBig = lines.Count > MaxDiffLines || lines.Sum(l => l.Length) > MaxDiffChars;
        return new FileEdit(Path.GetFileName(path), added, removed, tooBig ? Array.Empty<string>() : lines.ToArray());
    }

    static IEnumerable<string> Split(string? text) => string.IsNullOrEmpty(text) ? Array.Empty<string>() : text.TrimEnd('\n').Split('\n').Select(l => l.TrimEnd('\r'));

    /// <summary>Arquivos soltos numa sessão: os caminhos como o terminal escreve quando você arrasta (com aspas se tiver espaço).</summary>
    public static string DropText(IEnumerable<string> paths) =>
        string.Join(" ", paths.Select(p => p.Contains(' ') ? $"\"{p}\"" : p)) + " ";

    public static string Describe(string tool, JsonNode? input, bool full = false)
    {
        string? file = Str(input, "file_path") ?? Str(input, "notebook_path");
        string name = file != null ? Path.GetFileName(file) : "";
        string? cmd = Str(input, "command");
        return tool switch
        {
            "Edit" or "MultiEdit" or "NotebookEdit" => $"Editando {name}",
            "Write" => $"Criando {name}",
            "Read" => $"Lendo {name}",
            "Bash" or "PowerShell" when cmd != null => full ? $"Rodar o comando:\n{cmd}" : $"Rodando: {Short(cmd)}",
            "Grep" or "Glob" => "Procurando no código",
            "WebSearch" => full ? $"Pesquisar na web: {Str(input, "query")}" : "Pesquisando na web",
            "WebFetch" => full ? $"Abrir a página: {Str(input, "url")}" : "Lendo uma página da web",
            "Task" or "Agent" => "Chamando um subagente",
            "TodoWrite" => "Organizando a lista de tarefas",
            "" => "Trabalhando",
            _ => $"Usando {tool}",
        };
    }

    /// <summary>Último texto que o Claude escreveu, lido do fim do registro da sessão (para o aviso de "terminou").</summary>
    public static string? LastAssistantText(string? transcript)
    {
        try
        {
            if (transcript == null || !File.Exists(transcript)) return null;
            using var fs = new FileStream(transcript, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            fs.Seek(Math.Max(0, fs.Length - 256 * 1024), SeekOrigin.Begin); // só o fim: o registro pode ser enorme
            var lines = new StreamReader(fs).ReadToEnd().Split('\n');
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                if (!lines[i].Contains("\"assistant\"")) continue;
                try
                {
                    if (JsonNode.Parse(lines[i]) is not JsonObject row || Str(row, "type") != "assistant" || row["message"]?["content"] is not JsonArray content) continue;
                    var text = string.Join(" ", content.OfType<JsonObject>().Where(b => Str(b, "type") == "text").Select(b => Str(b, "text"))).Trim();
                    if (text.Length > 0) return text.Length > 200 ? text[..200] + "…" : text;
                }
                catch (System.Text.Json.JsonException) { } // linha pela metade
            }
        }
        catch (IOException) { }
        return null;
    }

    static string Short(string s)
    {
        s = s.Replace('\n', ' ').Trim();
        return s.Length > 40 ? s[..40] + "…" : s;
    }

    static string? Str(JsonNode? node, string key) =>
        node is JsonObject o && o[key] is JsonValue v && v.TryGetValue(out string? s) ? s : null;

    // ---------- limites do plano (vêm na status line do Claude Code, campo rate_limits) ----------

    public static PlanUsage? ParsePlan(JsonObject payload)
    {
        if (payload["rate_limits"] is not JsonObject limits) return null;
        var five = Window(limits["five_hour"]);
        var week = Window(limits["seven_day"]);
        return five == null && week == null ? null : new PlanUsage(five, week);
    }

    static PlanWindow? Window(JsonNode? node)
    {
        if (node is not JsonObject o || o["used_percentage"] is not JsonValue pv || !pv.TryGetValue(out double pct)) return null;
        if (pct < 0 || pct > 200) return null;
        if (o["resets_at"] is not JsonValue rv || !rv.TryGetValue(out double epoch) || epoch <= 0) return null;
        // Mais de 400 dias no futuro: provavelmente veio em milissegundos; melhor ignorar do que mostrar errado.
        if (epoch > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 400L * 86400) return null;
        return new PlanWindow(Math.Min(100, pct), DateTimeOffset.FromUnixTimeSeconds((long)epoch));
    }

    // Cada sessão manda a sua cópia; uma cópia velha não pode fazer o número voltar.
    static PlanUsage Merge(PlanUsage? cur, PlanUsage inc) => new(Latest(cur?.FiveHour, inc.FiveHour), Latest(cur?.SevenDay, inc.SevenDay));

    static PlanWindow? Latest(PlanWindow? cur, PlanWindow? inc) =>
        cur == null ? inc : inc == null ? cur
        : inc.ResetsAt > cur.ResetsAt ? inc
        : inc.ResetsAt < cur.ResetsAt ? cur
        : inc.UsedPct >= cur.UsedPct ? inc : cur;

    static string StatusLine(JsonObject p, PlanUsage? plan)
    {
        string model = p["model"] is JsonObject m && Str(m, "display_name") is { } d ? d : "Claude";
        var parts = new List<string> { model };
        if (plan?.FiveHour is { } f) parts.Add($"5h {f.UsedPct:0}%");
        if (plan?.SevenDay is { } w) parts.Add($"semana {w.UsedPct:0}%");
        return string.Join(" · ", parts);
    }
}
