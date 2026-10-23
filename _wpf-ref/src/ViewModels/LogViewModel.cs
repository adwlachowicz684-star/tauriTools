using System;
using System.Collections.ObjectModel;
using System.Text;
using System.Windows;
using System.Windows.Input;
using FenPeiXiangMuZu.Services;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>滚动日志视图模型：维护最近 N 条日志，供 UI 列表绑定与滚动展示。</summary>
public sealed class LogViewModel : ViewModelBase
{
    /// <summary>最多保留的日志条数，超出后移除头部最旧记录。</summary>
    public const int MaxEntries = 500;

    public LogViewModel()
    {
        Entries = new ObservableCollection<LogEntry>();
        CopyAllCommand = new RelayCommand(_ => CopyAll());
    }

    /// <summary>日志条目集合（按时间顺序，最新在末尾）。</summary>
    public ObservableCollection<LogEntry> Entries { get; }

    /// <summary>当前日志条数。</summary>
    public int Count => Entries.Count;

    /// <summary>复制全部日志到剪贴板（含时间戳，逐行）。</summary>
    public ICommand CopyAllCommand { get; }

    /// <summary>追加一条 INFO 级别日志。</summary>
    public void Info(string text)
    {
        Append(new LogEntry(text, "INFO"));
    }

    /// <summary>追加一条 ERR 级别日志。</summary>
    public void Error(string text)
    {
        Append(new LogEntry(text, "ERR"));
    }

    /// <summary>清空全部日志。</summary>
    public void Clear()
    {
        RunOnUi(() =>
        {
            Entries.Clear();
            Raise(nameof(Count));
        });
    }

    private void Append(LogEntry entry)
    {
        RunOnUi(() =>
        {
            Entries.Add(entry);
            while (Entries.Count > MaxEntries)
                Entries.RemoveAt(0);
            Raise(nameof(Count));
        });
    }

    private void CopyAll()
    {
        if (Entries.Count == 0) return;
        var sb = new StringBuilder();
        foreach (var e in Entries) sb.AppendLine(e.Display);
        Dialog.Service.SetClipboard(sb.ToString().TrimEnd());   // 服务内部封送 UI 线程
    }

    /// <summary>确保集合/剪贴板操作在 UI 线程执行（后台线程调用时封送，避免 ObservableCollection 跨线程异常）。</summary>
    private static void RunOnUi(Action action)
    {
        var app = System.Windows.Application.Current;
        var d = app?.Dispatcher;
        if (d == null || d.CheckAccess()) action();
        else d.BeginInvoke(action);
    }
}