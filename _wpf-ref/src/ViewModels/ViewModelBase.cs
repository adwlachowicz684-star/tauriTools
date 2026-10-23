using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace FenPeiXiangMuZu.ViewModels;

/// <summary>ViewModel 基类：MVVM 数据绑定支持（替代 PS 版的 $script: 全局变量 + 手动刷新）。</summary>
public abstract class ViewModelBase : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void Raise([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Raise(name);
        return true;
    }
}