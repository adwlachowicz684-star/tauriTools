namespace FenPeiXiangMuZu.Models;

/// <summary>
/// 单个 agent / skill 条目的轻量数据描述（模型层）。
/// 供「Agent/Skill 内容浏览区」展示与浏览使用。
/// </summary>
public sealed class AgentSkillItem
{
    /// <summary>叶子类别：agent / skill。</summary>
    public string Kind { get; }

    /// <summary>相对源目录（agent/ 或 skill/）的路径，以反斜杠分隔；文件含扩展名。</summary>
    public string RelPath { get; }

    /// <summary>源绝对路径（文件或目录）。</summary>
    public string SourcePath { get; }

    public AgentSkillItem(string kind, string relPath, string sourcePath)
    {
        Kind = kind;
        RelPath = relPath;
        SourcePath = sourcePath;
    }
}