using System.Windows.Input;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 快捷键键位串工具：规范串（与 KeyGestureConverter 兼容，可直接用于 KeyBinding）
/// 与友好显示串（D1→1、NumPad1→Num 1、OemPlus→+ 等）之间的转换。
/// </summary>
public static class ShortcutGesture
{
    /// <summary>把按键 + 修饰键格式化为规范键位串（如 Ctrl+L / Shift+D1 / F2）。</summary>
    public static string Format(Key key, ModifierKeys mods)
    {
        var parts = new List<string>();
        if (mods.HasFlag(ModifierKeys.Control)) parts.Add("Ctrl");
        if (mods.HasFlag(ModifierKeys.Alt)) parts.Add("Alt");
        if (mods.HasFlag(ModifierKeys.Shift)) parts.Add("Shift");
        if (mods.HasFlag(ModifierKeys.Windows)) parts.Add("Win");
        parts.Add(key.ToString());
        return string.Join("+", parts);
    }

    /// <summary>把规范键位串转为友好显示；空串/空白显示「未设置」。</summary>
    public static string Display(string gesture)
    {
        if (string.IsNullOrWhiteSpace(gesture)) return "未设置";
        var parts = gesture.Split('+');
        var mods = new List<string>();
        var i = 0;
        for (; i < parts.Length; i++)
        {
            if (parts[i] is "Ctrl" or "Alt" or "Shift" or "Win") mods.Add(parts[i]);
            else break;
        }
        var keyPart = i < parts.Length ? parts[i] : "";
        var keyDisplay = DisplayKey(keyPart);
        return mods.Count > 0 ? string.Join("+", mods) + "+" + keyDisplay : keyDisplay;
    }

    private static string DisplayKey(string key) => key switch
    {
        "D0" => "0", "D1" => "1", "D2" => "2", "D3" => "3", "D4" => "4",
        "D5" => "5", "D6" => "6", "D7" => "7", "D8" => "8", "D9" => "9",
        "NumPad0" => "Num 0", "NumPad1" => "Num 1", "NumPad2" => "Num 2", "NumPad3" => "Num 3",
        "NumPad4" => "Num 4", "NumPad5" => "Num 5", "NumPad6" => "Num 6", "NumPad7" => "Num 7",
        "NumPad8" => "Num 8", "NumPad9" => "Num 9",
        "OemPlus" => "+", "OemMinus" => "-", "OemComma" => ",", "OemPeriod" => ".",
        "OemQuestion" => "/", "OemQuotes" => "'", "OemSemicolon" => ";",
        "OemOpenBrackets" => "[", "OemCloseBrackets" => "]", "OemPipe" => "\\",
        "OemTilde" => "`", "OemBackslash" => "\\",
        "Return" => "Enter", "Escape" => "Esc", "Space" => "空格", "Tab" => "Tab",
        "Back" => "Backspace", "Delete" => "Del", "Insert" => "Ins",
        "Up" => "↑", "Down" => "↓", "Left" => "←", "Right" => "→",
        "PageUp" => "PgUp", "PageDown" => "PgDn", "Capital" => "CapsLock",
        _ => key,
    };
}
