from pathlib import Path
import re

path = Path(__file__).resolve().parents[1] / "docs" / "state_counts.txt"
text = path.read_text(encoding="utf-8")

new = """
N=13 optimized lookup sizes by remaining k
------------------------------------------
These are goofspiel-nash-style OPTIMIZED counts (rank-normalize + symmetry
+ score-range estimate), universe N=13, discard-on-tie W-L — then with
k=1 removed from storage (closed form; no strategic choice under W-L).

  opt(k)     = states stored at exactly remaining size k
  cum(1..K)  = endgame lookup table storing all stored k=1..K
  ~table     = estimated file size using published N=13 density
               (35 GB / 11,885,260,388 states ~= 3.17 bytes/state)

For an endgame book with cutoff K, read the cum / ~endgame table row for K.

  k |         opt(k) |      cum (1..k) | ~layer | ~endgame table (1..k)
  --|----------------|-----------------|--------|----------------------
  1 |              0 |               0 |     0 B |                   0 B
  2 |         15,834 |          15,834 |  49 KB |                 49 KB
  3 |        393,536 |         409,370 | 1.2 MB |               1.2 MB
  4 |      6,561,555 |       6,970,925 |  20 MB |                21 MB
  5 |     76,939,434 |      83,910,359 | 232 MB |               253 MB
  6 |    655,640,700 |     739,551,059 | 1.9 GB |               2.2 GB
  7 |  3,297,019,440 |   4,036,570,499 | 9.7 GB |                12 GB
  8 |  5,359,078,296 |   9,395,648,795 |  16 GB |                28 GB
  9 |  2,254,607,355 |  11,650,256,150 | 6.6 GB |                34 GB
 10 |    229,984,898 |  11,880,241,048 | 694 MB |                35 GB
 11 |      5,003,544 |  11,885,244,592 |  15 MB |                35 GB
 12 |         15,405 |  11,885,259,997 |  48 KB |                35 GB
 13 |              1 |  11,885,259,998 |    3 B |                35 GB

  Stored total (k>=2): 11,885,259,998 states / ~35 GB
  (published full table was 11,885,260,388 including 390 k=1 entries).

  Our solver: k=1 is evaluated closed-form and never memoized.
  Rollover rules may still inflate k>=2 counts vs discard-on-tie.

  Unoptimized "original" formula (much larger; not what you ship):
    original(k) = C(13,k)^3 * (2*(91 - k(k+1)/2) + 1)
    totals ~2.02 trillion — see goofspiel-nash README.


"""

pat = r"\nN=13 optimized lookup sizes by remaining k\n.*?(?=\nOur solver vs theirs)"
text2, n = re.subn(pat, "\n" + new, text, count=1, flags=re.S)
if n != 1:
    raise SystemExit(f"replace failed n={n}")
path.write_text(text2, encoding="utf-8")
print("docs updated")
