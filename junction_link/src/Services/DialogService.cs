using System.Windows;
using System.Windows.Threading;

namespace FenPeiXiangMuZu.Services;

/// <summary>删除收藏确认框的勾选结果：true=保留该项（跳过对应清理）。</summary>
public sealed record DeleteFavoriteChoice(bool KeepLinks, bool KeepIcon, bool KeepColor);

/// <summary>
/// UI 对话框/剪贴板服务抽象：VM 层经此访问弹窗与剪贴板，不直接依赖 MessageBox/Clipboard，
/// 便于单元测试替换实现（如记录式假实现）与未来统一换肤。
/// </summary>
public interface IDialogService
{
    /// <summary>信息/警告提示（仅确定按钮）。</summary>
    void Alert(string message, string title = "分配项目组");

    /// <summary>是/否确认框；返回用户是否选择「是」。</summary>
    bool Confirm(string message, string title = "确认");

    /// <summary>删除收藏确认框：三个勾选默认不勾，置灰项表示无可清理内容；「删除」返回勾选结果，取消/关闭返回 null。</summary>
    DeleteFavoriteChoice? ConfirmDeleteFavorite(string title, string message,
        bool linkEnabled, bool iconEnabled, bool colorEnabled);

    /// <summary>写入文本到系统剪贴板。</summary>
    void SetClipboard(string text);

    /// <summary>单字段输入/重命名对话框（PromptDialog）；确定返回输入文本，取消/关闭返回 null。</summary>
    string? Prompt(string title, string label, string initial, Func<string, string?> validate);
}

/// <summary>默认实现：System.Windows.MessageBox + Clipboard + PromptDialog，内部自动封送到 UI 线程。</summary>
public sealed class DefaultDialogService : IDialogService
{
    public void Alert(string message, string title = "分配项目组")
        => RunOnUi(() => MessageBox.Show(message, title, MessageBoxButton.OK, MessageBoxImage.Warning));

    public bool Confirm(string message, string title = "确认")
    {
        var result = MessageBoxResult.No;
        RunOnUi(() => result = MessageBox.Show(message, title, MessageBoxButton.YesNo, MessageBoxImage.Question));
        return result == MessageBoxResult.Yes;
    }

    public DeleteFavoriteChoice? ConfirmDeleteFavorite(string title, string message,
        bool linkEnabled, bool iconEnabled, bool colorEnabled)
        => RunOnUi(() => Views.DeleteFavoriteDialog.Show(title, message, linkEnabled, iconEnabled, colorEnabled));

    public void SetClipboard(string text)
        => RunOnUi(() =>
        {
            try { Clipboard.SetText(text); }
            catch { /* 剪贴板被其他进程占用等场景静默 */ }
        });

    public string? Prompt(string title, string label, string initial, Func<string, string?> validate)
        => RunOnUi(() => Views.PromptDialog.Show(title, label, initial, validate));

    private static void RunOnUi(Action action)
        => RunOnUi<object?>(() => { action(); return null; });

    private static T RunOnUi<T>(Func<T> func)
    {
        var d = Application.Current?.Dispatcher;
        if (d == null || d.CheckAccess()) return func();
        return d.Invoke(func);
    }
}

/// <summary>轻量服务入口：默认用 DefaultDialogService，测试或特殊宿主可整体替换。</summary>
public static class Dialog
{
    public static IDialogService Service { get; set; } = new DefaultDialogService();
}
