namespace Orbi;

// Páginas do notch: em que ordem aparecem (uma bolinha cada) e quais estão escondidas, como no Orbi em Rust.
public static class PageOrder
{
    public static readonly (string Tag, string Name)[] All =
    {
        ("home", "Início"), ("calendar", "Calendário"), ("shelf", "Bandeja"), ("clip", "Área de transferência"), ("notes", "Notas"),
        ("system", "Sistema"), ("todo", "Tarefas"), ("shortcuts", "Atalhos"), ("ai", "IA"),
    };

    /// <summary>Config editada à mão ou de versão antiga: tira repetidas e desconhecidas e põe as que faltam no fim.</summary>
    public static List<string> Fix(IEnumerable<string>? saved)
    {
        var known = All.Select(p => p.Tag).ToList();
        var order = (saved ?? Array.Empty<string>()).Where(known.Contains).Distinct().ToList();
        order.AddRange(known.Where(t => !order.Contains(t)));
        return order;
    }

    /// <summary>Sobe (-1) ou desce (+1) a página na posição i; fora dos limites não muda nada.</summary>
    public static void Move(List<string> order, int i, int dir)
    {
        int j = i + dir;
        if (i < 0 || j < 0 || i >= order.Count || j >= order.Count) return;
        (order[i], order[j]) = (order[j], order[i]);
    }

    /// <summary>A página seguinte (ou anterior) entre as visíveis, parando nas pontas.</summary>
    public static string Step(IReadOnlyList<string> visible, string current, int dir)
    {
        int i = Math.Max(0, visible.ToList().IndexOf(current));
        return visible[Math.Clamp(i + dir, 0, visible.Count - 1)];
    }
}
