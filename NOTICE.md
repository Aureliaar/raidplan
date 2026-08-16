# Third-party content

## Art under `public/assets`

The job/role tokens, enemy tokens, waymarks, field markers and arena backdrops are the
asset set from **[XIVPlan](https://github.com/joelspadin/xivplan)** by Joel Spadin, which is
distributed under the MIT License. They were copied from that project's `public/` directory.

```
MIT License

Copyright (c) 2021 Joel Spadin

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

The icons themselves are derived from **FINAL FANTASY XIV** © SQUARE ENIX CO., LTD. They are
reused here for a non-commercial fan tool, the same footing XIVPlan uses. FINAL FANTASY is a
registered trademark of Square Enix Holdings Co., Ltd. This project is not affiliated with or
endorsed by Square Enix.

If you deploy this publicly and would rather not host that art, delete `public/assets` and
run `npm run assets:manifest` — every renderer falls back to the vector tokens it ships with.
