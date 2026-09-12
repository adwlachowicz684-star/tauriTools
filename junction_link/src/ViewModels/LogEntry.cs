using System;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>单条日志记录；Level 取 "INFO"/"ERR" 供 UI 上色，Display 为展示文本。</summary>
public sealed class LogEntry
{
    public LogEntry(string text, string level = "INFO")
    {
        Time = DateTime.Now;
        Level = level;
        Text = text;
    }

    /// <summary>记录时间。</summary>
    public DateTime Time { get; }

    /// <summary>级别："INFO" 或 "ERR"（只读：日志写入后不应再变更）。</summary>
    public string Level { get; }

    /// <summary>日志正文。</summary>
    public string Text { get; }

    /// <summary>展示文本："[HH:mm:ss] {Text}"。</summary>
    public string Display => $"[{Time:HH:mm:ss}] {Text}";
}