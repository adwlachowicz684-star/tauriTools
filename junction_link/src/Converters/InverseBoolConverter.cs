using System.Globalization;
using System.Windows.Data;

namespace FenPeiXiangMuZu.Converters;

/// <summary>布尔取反（true↔false），用于让某组设置仅在另一开关关闭时可用。</summary>
public sealed class InverseBoolConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is bool b && b ? false : true;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => value is bool b && b ? false : true;
}
