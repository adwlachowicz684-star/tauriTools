using System.Windows;

namespace FenPeiXiangMuZu.Views;

/// <summary>
/// 通用取色助手：把「标签改色」的常驻色盘 <see cref="ColorPickDialog"/> 封装为
/// 「弹一次取一个颜色」的独立方法，随处可调用（新建主题面板、取色需求等）。
/// </summary>
public static class ColorPicker
{
    /// <summary>弹出取色色盘，返回用户最终选定颜色（#RRGGBB）；取消 / Esc / 恢复默认返回 null。</summary>
    /// <param name="owner">宿主窗口；为 null 时取当前主窗口。</param>
    /// <param name="title">色盘标题。</param>
    /// <param name="initialHex">初始颜色；可为 null。</param>
    public static string? Pick(Window? owner, string title, string? initialHex)
    {
        string? result = null;
        ColorPickDialog? dlg = null;
        dlg = new ColorPickDialog(title, initialHex, Array.Empty<string>(),
            onLiveChange: _ => { },
            onApply: hex => { result = hex; },
            onSaveCustomColors: _ => { },
            hint: "拖动色盘 / 单击色块 / 吸管 / 输入 RGB 调整颜色；点右下角「确认」应用并返回，Esc 取消。",
            onCancel: () => result = null);
        dlg.Owner = owner ?? Application.Current.MainWindow;
        dlg.ShowDialog();
        return result;
    }
}