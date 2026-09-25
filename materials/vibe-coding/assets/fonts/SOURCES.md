# Font sources and licenses

Downloaded 2026-09-25 from Google Fonts. Original, unmodified WOFF2 assets. Only normal style; only Latin and Cyrillic subsets. No Greek, Vietnamese, or extended subsets.

Variable ranges: Inter Tight 600–900; Inter 400–800; JetBrains Mono 400–700. All faces use font-display: swap. Include ../fonts.css from the page CSS/HTML; the URLs inside it resolve relative to assets/fonts.css.

Official CSS source:
https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600..900&family=Inter:wght@400..800&family=JetBrains+Mono:wght@400..700&display=swap

The Google Fonts response was requested with a current Chromium User-Agent to receive WOFF2 variable faces. Unicode ranges are preserved verbatim in fonts.css.

| Local file | Family | Weight | Original URL | SHA-256 |
|---|---|---|---|---|
| inter-cyrillic.woff2 | Inter | 400 800 | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7SUc.woff2 | 71d5ee93cc1e9f1d520a3a8b66456de18c7879d8df09d57fcd2eaff75fef0075 |
| inter-latin.woff2 | Inter | 400 800 | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2 | 3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62 |
| inter-tight-cyrillic.woff2 | Inter Tight | 600 900 | https://fonts.gstatic.com/s/intertight/v9/NGSwv5HMAFg6IuGlBNMjxLsD8ah8QA.woff2 | 3937173d62f238179ca073aee632d53ebc088967ac841bf213211be05720881a |
| inter-tight-latin.woff2 | Inter Tight | 600 900 | https://fonts.gstatic.com/s/intertight/v9/NGSwv5HMAFg6IuGlBNMjxLsH8ag.woff2 | 77fefe8ca19b9f69b5284832c519e0493127c1f091f0a8936884be7721c4e618 |
| jetbrains-mono-cyrillic.woff2 | JetBrains Mono | 400 700 | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxTcwhsk.woff2 | e17cfd15fb96909d64095015f958207063a0c07191da3512df7d560a781aebdf |
| jetbrains-mono-latin.woff2 | JetBrains Mono | 400 700 | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2 | 83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be |

## Licenses

All three font families are redistributed under the SIL Open Font License 1.1. Full license texts are shipped alongside these files; original copyright statements are retained.

- inter-OFL.txt: https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt
- intertight-OFL.txt: https://raw.githubusercontent.com/google/fonts/main/ofl/intertight/OFL.txt
- jetbrainsmono-OFL.txt: https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt

## Coverage

These are the official basic Cyrillic and Latin subsets, not full Unicode fonts. The ruble sign U+20BD is supplied by two additional official, unmodified Google Fonts text subsets (Inter and Inter Tight). These faces are restricted to unicode-range: U+20BD, so all other characters continue using the original Cyrillic and Latin subsets.

## Ruble subsets

Official CSS request:
https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600..900&family=Inter:wght@400..800&display=swap&text=%E2%82%BD

| Local file | Family | Bytes | Original URL | SHA-256 |
|---|---|---|---|---|
| inter-ruble.woff2 | Inter | 2284 | https://fonts.gstatic.com/l/font?kit=UcC73FwrK3iLTeHuS_nVMrMxCp50SjIq14D9k8SM&skey=c491285d6722e4fa&v=v20 | 166e11a344e489bb2fd326168dbf8c435fba9e44501c98a67d6920243399f7c8 |
| inter-tight-ruble.woff2 | Inter Tight | 1184 | https://fonts.gstatic.com/l/font?kit=NGSwv5HMAFg6IuGlBNMjxIsF466mw9I&skey=68e231d243ba982&v=v9 | 4e399ff22f34b3889ff9d186a7dd92ac05f6bd04d1e337a455cec5ffd475f99b |

Both additional files retain the family-specific variable weight range, use font-display: swap, and are covered by the corresponding OFL license shipped above. They were validated with fontTools for a variable wght axis and U+20BD glyph.
