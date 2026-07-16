# cython: language_level=3, boundscheck=False, wraparound=False, cdivision=True
"""Cython hot path: flat open-addressing memos + inlined small matrix games."""

from libc.stdint cimport int64_t, uint64_t, uint8_t
from libc.string cimport memset
from cpython.mem cimport PyMem_Malloc, PyMem_Free

cdef extern from *:
    """
    #ifdef _MSC_VER
    #include <intrin.h>
    static __inline int gops_ctz64(unsigned long long x) {
        unsigned long i;
        _BitScanForward64(&i, x);
        return (int)i;
    }
    static __inline int gops_popcnt64(unsigned long long x) {
        return (int)__popcnt64(x);
    }
    static __inline int gops_clz64(unsigned long long x) {
        unsigned long i;
        if (x == 0) return 64;
        _BitScanReverse64(&i, x);
        return 63 - (int)i;
    }
    #else
    static inline int gops_ctz64(unsigned long long x) { return __builtin_ctzll(x); }
    static inline int gops_popcnt64(unsigned long long x) { return __builtin_popcountll(x); }
    static inline int gops_clz64(unsigned long long x) {
        return x ? __builtin_clzll(x) : 64;
    }
    #endif
    """
    int gops_ctz64(uint64_t x) noexcept nogil
    int gops_popcnt64(uint64_t x) noexcept nogil
    int gops_clz64(uint64_t x) noexcept nogil


cdef double FORCED_NONE = 2.0
cdef uint8_t EMPTY = 0
cdef uint8_t FILLED = 1
cdef uint8_t TOMB = 2


# Turn profiling (single-threaded; reset around strategy()/value()).
cdef struct TurnStatsC:
    long long visits
    long long cache_hit
    long long forced
    long long plateau
    long long piecewise
    long long k1
    long long sym0
    long long frac_new
    long long plat_new
    long long matrix
    long long m_pure
    long long m_2x2
    long long m_lp
    long long m_approx


cdef TurnStatsC _ST


cpdef void reset_turn_stats():
    memset(&_ST, 0, sizeof(TurnStatsC))


cpdef dict turn_stats():
    """Snapshot of DP / matrix counters since last reset_turn_stats()."""
    return {
        "visits": _ST.visits,
        "cache_hit": _ST.cache_hit,
        "forced": _ST.forced,
        "plateau": _ST.plateau,
        "piecewise": _ST.piecewise,
        "k1": _ST.k1,
        "sym0": _ST.sym0,
        "frac_new": _ST.frac_new,
        "plat_new": _ST.plat_new,
        "matrix": _ST.matrix,
        "m_pure": _ST.m_pure,
        "m_2x2": _ST.m_2x2,
        "m_lp": _ST.m_lp,
        "m_approx": _ST.m_approx,
    }


cdef inline uint64_t mix64(uint64_t z) noexcept nogil:
    z = (z ^ (z >> 30)) * <uint64_t>0xbf58476d1ce4e5b9
    z = (z ^ (z >> 27)) * <uint64_t>0x94d049bb133111eb
    return z ^ (z >> 31)


cdef inline int64_t pack_net_key(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending
) noexcept nogil:
    return <int64_t>(h1 | (h2 << 13) | (rest << 26) | (pending << 39))


cdef inline int64_t pack_key(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending, int sd
) noexcept nogil:
    return <int64_t>(
        h1
        | (h2 << 13)
        | (rest << 26)
        | (pending << 39)
        | ((<uint64_t>(sd + 128)) << 52)
    )


cdef inline int popcount64(uint64_t x) noexcept nogil:
    return gops_popcnt64(x)


cdef inline int ctz64(uint64_t v) noexcept nogil:
    return gops_ctz64(v)


cdef inline int bit_length64(uint64_t x) noexcept nogil:
    if x == 0:
        return 0
    return 64 - gops_clz64(x)


cdef inline int mask_sum(uint64_t mask) noexcept nogil:
    cdef int s = 0
    cdef uint64_t bit
    while mask:
        bit = mask & (~mask + 1)
        s += bit_length64(bit)
        mask ^= bit
    return s


cdef inline double terminal(int sd) noexcept nogil:
    if sd > 0:
        return 1.0
    if sd < 0:
        return -1.0
    return 0.0


cdef inline uint64_t lowest_bit(uint64_t m) noexcept nogil:
    return m & (~m + 1)


# ---------------------------------------------------------------------------
# Open-addressing maps (int64 key)
# ---------------------------------------------------------------------------

cdef class FloatMap:
    """int64 -> float64 open-addressing hash map (Python Mapping-ish)."""

    cdef int64_t* _keys
    cdef double* _vals
    cdef uint8_t* _state
    cdef Py_ssize_t n_buckets
    cdef Py_ssize_t n_items
    cdef Py_ssize_t n_occupied  # filled + tombstones

    def __cinit__(self, object mapping=None):
        self._keys = NULL
        self._vals = NULL
        self._state = NULL
        self.n_buckets = 0
        self.n_items = 0
        self.n_occupied = 0
        self._alloc(1 << 18)
        if mapping is not None:
            self.update(mapping)

    def __dealloc__(self):
        if self._keys != NULL:
            PyMem_Free(self._keys)
        if self._vals != NULL:
            PyMem_Free(self._vals)
        if self._state != NULL:
            PyMem_Free(self._state)

    cdef void _alloc(self, Py_ssize_t n):
        self._keys = <int64_t*>PyMem_Malloc(n * sizeof(int64_t))
        self._vals = <double*>PyMem_Malloc(n * sizeof(double))
        self._state = <uint8_t*>PyMem_Malloc(n * sizeof(uint8_t))
        if self._keys == NULL or self._vals == NULL or self._state == NULL:
            raise MemoryError()
        self.n_buckets = n
        self.n_items = 0
        self.n_occupied = 0
        memset(self._state, 0, n)

    cdef void _resize(self, Py_ssize_t new_n):
        cdef int64_t* ok = self._keys
        cdef double* ov = self._vals
        cdef uint8_t* os = self._state
        cdef Py_ssize_t old_n = self.n_buckets
        cdef Py_ssize_t i
        cdef int64_t* nk
        cdef double* nv
        cdef uint8_t* ns

        nk = <int64_t*>PyMem_Malloc(new_n * sizeof(int64_t))
        nv = <double*>PyMem_Malloc(new_n * sizeof(double))
        ns = <uint8_t*>PyMem_Malloc(new_n * sizeof(uint8_t))
        if nk == NULL or nv == NULL or ns == NULL:
            raise MemoryError()
        memset(ns, 0, new_n)
        self._keys = nk
        self._vals = nv
        self._state = ns
        self.n_buckets = new_n
        self.n_items = 0
        self.n_occupied = 0
        for i in range(old_n):
            if os[i] == FILLED:
                self._insert_raw(ok[i], ov[i])
        PyMem_Free(ok)
        PyMem_Free(ov)
        PyMem_Free(os)

    cdef void _grow_if_needed(self):
        if self.n_occupied * 10 >= self.n_buckets * 7:
            self._resize(self.n_buckets << 1)

    cdef Py_ssize_t _find(self, int64_t key) noexcept nogil:
        """Return bucket index of key, or where to insert (EMPTY/TOMB), or -1."""
        cdef uint64_t h = mix64(<uint64_t>key)
        cdef Py_ssize_t mask = self.n_buckets - 1
        cdef Py_ssize_t i = <Py_ssize_t>(h & <uint64_t>mask)
        cdef Py_ssize_t first_tomb = -1
        cdef uint8_t st
        while True:
            st = self._state[i]
            if st == EMPTY:
                return first_tomb if first_tomb >= 0 else i
            if st == TOMB:
                if first_tomb < 0:
                    first_tomb = i
            elif self._keys[i] == key:
                return i
            i = (i + 1) & mask

    cdef bint _lookup(self, int64_t key, double* out) noexcept nogil:
        cdef uint64_t h = mix64(<uint64_t>key)
        cdef Py_ssize_t mask = self.n_buckets - 1
        cdef Py_ssize_t i = <Py_ssize_t>(h & <uint64_t>mask)
        cdef uint8_t st
        while True:
            st = self._state[i]
            if st == EMPTY:
                return False
            if st == FILLED and self._keys[i] == key:
                out[0] = self._vals[i]
                return True
            i = (i + 1) & mask

    cdef void _insert_raw(self, int64_t key, double val) noexcept nogil:
        cdef Py_ssize_t i = self._find(key)
        if self._state[i] == FILLED:
            self._vals[i] = val
            return
        if self._state[i] == EMPTY:
            self.n_occupied += 1
        self._state[i] = FILLED
        self._keys[i] = key
        self._vals[i] = val
        self.n_items += 1

    cdef void set_c(self, int64_t key, double val):
        self._grow_if_needed()
        cdef Py_ssize_t i = self._find(key)
        if self._state[i] == FILLED:
            self._vals[i] = val
            return
        if self._state[i] == EMPTY:
            self.n_occupied += 1
        self._state[i] = FILLED
        self._keys[i] = key
        self._vals[i] = val
        self.n_items += 1

    cdef void clear_c(self):
        if self.n_buckets > 0:
            memset(self._state, 0, self.n_buckets)
        self.n_items = 0
        self.n_occupied = 0

    def __len__(self):
        return self.n_items

    def __contains__(self, object key):
        cdef double tmp
        return self._lookup(<int64_t>key, &tmp)

    def __getitem__(self, object key):
        cdef double v
        if not self._lookup(<int64_t>key, &v):
            raise KeyError(key)
        return v

    def __setitem__(self, object key, object value):
        self.set_c(<int64_t>key, <double>value)

    def get(self, object key, object default=None):
        cdef double v
        if self._lookup(<int64_t>key, &v):
            return v
        return default

    def clear(self):
        self.clear_c()

    def update(self, object mapping):
        cdef object k, v
        if isinstance(mapping, FloatMap):
            self._update_from_floatmap(<FloatMap>mapping)
            return
        for k, v in mapping.items():
            self.set_c(<int64_t>k, <double>v)

    cdef void _update_from_floatmap(self, FloatMap other) noexcept:
        cdef Py_ssize_t i
        for i in range(other.n_buckets):
            if other.state[i] == FILLED:
                self.set_c(other.keys[i], other.vals[i])

    def items(self):
        cdef list out = []
        cdef Py_ssize_t i
        for i in range(self.n_buckets):
            if self._state[i] == FILLED:
                out.append((self._keys[i], self._vals[i]))
        return out

    def keys(self):
        cdef list out = []
        cdef Py_ssize_t i
        for i in range(self.n_buckets):
            if self._state[i] == FILLED:
                out.append(self._keys[i])
        return out

    def values(self):
        cdef list out = []
        cdef Py_ssize_t i
        for i in range(self.n_buckets):
            if self._state[i] == FILLED:
                out.append(self._vals[i])
        return out

    def to_dict(self):
        return dict(self.items())


cdef class IntMap:
    """int64 -> int64 open-addressing hash map (dominance nets)."""

    cdef int64_t* _keys
    cdef int64_t* _vals
    cdef uint8_t* _state
    cdef Py_ssize_t n_buckets
    cdef Py_ssize_t n_items
    cdef Py_ssize_t n_occupied

    def __cinit__(self):
        self._keys = NULL
        self._vals = NULL
        self._state = NULL
        self.n_buckets = 0
        self.n_items = 0
        self.n_occupied = 0
        self._alloc(1 << 18)

    def __dealloc__(self):
        if self._keys != NULL:
            PyMem_Free(self._keys)
        if self._vals != NULL:
            PyMem_Free(self._vals)
        if self._state != NULL:
            PyMem_Free(self._state)

    cdef void _alloc(self, Py_ssize_t n):
        self._keys = <int64_t*>PyMem_Malloc(n * sizeof(int64_t))
        self._vals = <int64_t*>PyMem_Malloc(n * sizeof(int64_t))
        self._state = <uint8_t*>PyMem_Malloc(n * sizeof(uint8_t))
        if self._keys == NULL or self._vals == NULL or self._state == NULL:
            raise MemoryError()
        self.n_buckets = n
        self.n_items = 0
        self.n_occupied = 0
        memset(self._state, 0, n)

    cdef void _resize(self, Py_ssize_t new_n):
        cdef int64_t* ok = self._keys
        cdef int64_t* ov = self._vals
        cdef uint8_t* os = self._state
        cdef Py_ssize_t old_n = self.n_buckets
        cdef Py_ssize_t i
        cdef int64_t* nk = <int64_t*>PyMem_Malloc(new_n * sizeof(int64_t))
        cdef int64_t* nv = <int64_t*>PyMem_Malloc(new_n * sizeof(int64_t))
        cdef uint8_t* ns = <uint8_t*>PyMem_Malloc(new_n * sizeof(uint8_t))
        if nk == NULL or nv == NULL or ns == NULL:
            raise MemoryError()
        memset(ns, 0, new_n)
        self._keys = nk
        self._vals = nv
        self._state = ns
        self.n_buckets = new_n
        self.n_items = 0
        self.n_occupied = 0
        for i in range(old_n):
            if os[i] == FILLED:
                self._insert_raw(ok[i], ov[i])
        PyMem_Free(ok)
        PyMem_Free(ov)
        PyMem_Free(os)

    cdef void _grow_if_needed(self):
        if self.n_occupied * 10 >= self.n_buckets * 7:
            self._resize(self.n_buckets << 1)

    cdef void _insert_raw(self, int64_t key, int64_t val) noexcept nogil:
        cdef Py_ssize_t i = self._find(key)
        if self._state[i] == FILLED:
            self._vals[i] = val
            return
        if self._state[i] == EMPTY:
            self.n_occupied += 1
        self._state[i] = FILLED
        self._keys[i] = key
        self._vals[i] = val
        self.n_items += 1

    cdef Py_ssize_t _find(self, int64_t key) noexcept nogil:
        cdef uint64_t h = mix64(<uint64_t>key)
        cdef Py_ssize_t mask = self.n_buckets - 1
        cdef Py_ssize_t i = <Py_ssize_t>(h & <uint64_t>mask)
        cdef Py_ssize_t first_tomb = -1
        cdef uint8_t st
        while True:
            st = self._state[i]
            if st == EMPTY:
                return first_tomb if first_tomb >= 0 else i
            if st == TOMB:
                if first_tomb < 0:
                    first_tomb = i
            elif self._keys[i] == key:
                return i
            i = (i + 1) & mask

    cdef bint _lookup(self, int64_t key, int64_t* out) noexcept nogil:
        cdef uint64_t h = mix64(<uint64_t>key)
        cdef Py_ssize_t mask = self.n_buckets - 1
        cdef Py_ssize_t i = <Py_ssize_t>(h & <uint64_t>mask)
        cdef uint8_t st
        while True:
            st = self._state[i]
            if st == EMPTY:
                return False
            if st == FILLED and self._keys[i] == key:
                out[0] = self._vals[i]
                return True
            i = (i + 1) & mask

    cdef void set_c(self, int64_t key, int64_t val):
        self._grow_if_needed()
        cdef Py_ssize_t i = self._find(key)
        if self._state[i] == FILLED:
            self._vals[i] = val
            return
        if self._state[i] == EMPTY:
            self.n_occupied += 1
        self._state[i] = FILLED
        self._keys[i] = key
        self._vals[i] = val
        self.n_items += 1

    cdef void clear_c(self):
        if self.n_buckets > 0:
            memset(self._state, 0, self.n_buckets)
        self.n_items = 0
        self.n_occupied = 0

    def clear(self):
        self.clear_c()


# Module-level net memos (no Python dict / tuple keys)
cdef IntMap _NET_MEMO = IntMap()
cdef IntMap _NET_BOUNDS = IntMap()  # packed (m, m_swap) as int64
# Per-shell Nash ±1 plateaus in canonical sd: (last_minus_sd, first_plus_sd)
cdef IntMap _PLATEAU = IntMap()

cdef int SD_NONE = -10000
cdef double VAL_EPS = 1e-9


cdef inline int64_t pack_shell(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending
) noexcept nogil:
    return <int64_t>(h1 | (h2 << 13) | (rest << 26) | (pending << 39))


cdef inline int64_t pack_plateau(int last_minus, int first_plus) noexcept nogil:
    return (<int64_t>(last_minus - SD_NONE) << 32) | <int64_t>(first_plus - SD_NONE)


cdef inline void unpack_plateau(
    int64_t packed, int* last_minus, int* first_plus
) noexcept nogil:
    last_minus[0] = <int>(packed >> 32) + SD_NONE
    first_plus[0] = <int>(packed & <int64_t>0xffffffff) + SD_NONE


cdef void plateau_set(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending,
    int last_minus, int first_plus,
):
    _PLATEAU.set_c(
        pack_shell(h1, h2, rest, pending),
        pack_plateau(last_minus, first_plus),
    )


cdef void plateau_note(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending,
    int sd, int which,
):
    """Tighten plateau: which=+1 or -1 after a Nash-terminal solve."""
    cdef int64_t sk = pack_shell(h1, h2, rest, pending)
    cdef int64_t packed
    cdef int lm = SD_NONE
    cdef int fp = SD_NONE
    if _PLATEAU._lookup(sk, &packed):
        unpack_plateau(packed, &lm, &fp)
    if which > 0:
        if fp == SD_NONE or sd < fp:
            fp = sd
    else:
        if lm == SD_NONE or sd > lm:
            lm = sd
    _PLATEAU.set_c(sk, pack_plateau(lm, fp))


cdef bint plateau_lookup(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending, int sd,
    double* out_v,
):
    """If sd is in a known ±1 plateau, set out_v to ±1 and return True."""
    cdef int64_t packed
    cdef int lm, fp
    if not _PLATEAU._lookup(pack_shell(h1, h2, rest, pending), &packed):
        return False
    unpack_plateau(packed, &lm, &fp)
    if fp != SD_NONE and sd >= fp:
        out_v[0] = 1.0
        return True
    if lm != SD_NONE and sd <= lm:
        out_v[0] = -1.0
        return True
    return False


cdef void commit_value(
    FloatMap cache,
    int64_t key,
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending,
    int sd,
    double v,
):
    """Store fractional values only; ±1 go into per-shell plateaus."""
    if v >= 1.0 - VAL_EPS:
        _ST.plat_new += 1
        plateau_note(h1, h2, rest, pending, sd, 1)
        return
    if v <= -1.0 + VAL_EPS:
        _ST.plat_new += 1
        plateau_note(h1, h2, rest, pending, sd, -1)
        return
    _ST.frac_new += 1
    cache.set_c(key, v)


cdef inline int64_t pack_bounds(int m, int m_swap) noexcept nogil:
    return (<int64_t>(m + 1_000_000) << 32) | <int64_t>(m_swap + 1_000_000)


cdef inline void unpack_bounds(int64_t packed, int* m, int* m_swap) noexcept nogil:
    m[0] = <int>((packed >> 32) - 1_000_000)
    m_swap[0] = <int>((packed & <int64_t>0xffffffff) - 1_000_000)


# ---------------------------------------------------------------------------
# Hands / dominance
# ---------------------------------------------------------------------------

cdef void normalize_hands(
    uint64_t h1, uint64_t h2, int n,
    uint64_t *out_h1, uint64_t *out_h2,
) noexcept nogil:
    cdef uint64_t union_m = h1 | h2
    cdef uint64_t nh1 = 0
    cdef uint64_t nh2 = 0
    cdef int nb = 0
    cdef int b
    cdef uint64_t bit, mapped
    for b in range(n):
        bit = <uint64_t>1 << b
        if union_m & bit:
            mapped = <uint64_t>1 << nb
            if h1 & bit:
                nh1 |= mapped
            if h2 & bit:
                nh2 |= mapped
            nb += 1
    out_h1[0] = nh1
    out_h2[0] = nh2


cdef int sum_d_largest(uint64_t mask, int n, int d) noexcept nogil:
    if d <= 0:
        return 0
    cdef int s = 0
    cdef int taken = 0
    cdef int b
    for b in range(n - 1, -1, -1):
        if (mask >> b) & 1:
            s += b + 1
            taken += 1
            if taken == d:
                break
    return s


cdef int max_p2_net(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending, int n
):
    """
    Max of (points2 - points1) over pure playouts + prize orders.

    Hands are relative-rank normalized for the memo key and recursion
    (bid order-isomorphism). rest/pending stay absolute so stakes
    (mask_sum) are unchanged — exact W–L nets.
    """
    cdef uint64_t nh1, nh2
    cdef int64_t key
    cdef int64_t hit
    cdef int best, stake, vi, vj, v
    cdef uint64_t m, bit, m1, m2, bit_i, bit_j, h1n, h2n, rm, pbit
    cdef int bi, bj

    normalize_hands(h1, h2, n, &nh1, &nh2)
    key = pack_net_key(nh1, nh2, rest, pending)
    if _NET_MEMO._lookup(key, &hit):
        return <int>hit

    if nh1 == 0:
        _NET_MEMO.set_c(key, 0)
        return 0

    if pending == 0:
        if rest == 0:
            _NET_MEMO.set_c(key, 0)
            return 0
        best = -10**9
        m = rest
        while m:
            bit = lowest_bit(m)
            v = max_p2_net(nh1, nh2, rest ^ bit, bit, n)
            if v > best:
                best = v
            m ^= bit
        _NET_MEMO.set_c(key, best)
        return best

    stake = mask_sum(pending)
    best = -10**9
    m1 = nh1
    while m1:
        bit_i = lowest_bit(m1)
        bi = ctz64(bit_i)
        h1n = nh1 ^ bit_i
        vi = bi + 1
        m2 = nh2
        while m2:
            bit_j = lowest_bit(m2)
            bj = ctz64(bit_j)
            h2n = nh2 ^ bit_j
            vj = bj + 1
            if vi > vj:
                v = -stake + max_p2_net(h1n, h2n, rest, 0, n)
                if v > best:
                    best = v
            elif vi < vj:
                v = stake + max_p2_net(h1n, h2n, rest, 0, n)
                if v > best:
                    best = v
            elif rest == 0:
                if 0 > best:
                    best = 0
            else:
                rm = rest
                while rm:
                    pbit = lowest_bit(rm)
                    v = max_p2_net(h1n, h2n, rest ^ pbit, pending | pbit, n)
                    if v > best:
                        best = v
                    rm ^= pbit
            m2 ^= bit_j
        m1 ^= bit_i
    _NET_MEMO.set_c(key, best)
    return best


cdef void net_bounds(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending, int n,
    int *out_m, int *out_mswap,
):
    cdef uint64_t nh1, nh2
    cdef int64_t key
    cdef int64_t packed
    cdef int m, m_swap

    normalize_hands(h1, h2, n, &nh1, &nh2)
    key = pack_net_key(nh1, nh2, rest, pending)
    if _NET_BOUNDS._lookup(key, &packed):
        unpack_bounds(packed, out_m, out_mswap)
        return
    m = max_p2_net(nh1, nh2, rest, pending, n)
    m_swap = max_p2_net(nh2, nh1, rest, pending, n)
    _NET_BOUNDS.set_c(key, pack_bounds(m, m_swap))
    out_m[0] = m
    out_mswap[0] = m_swap


cdef double forced_wl(
    uint64_t h1, uint64_t h2, uint64_t rem_mask, int n, int sd,
    uint64_t rest, uint64_t pending, bint have_rp,
):
    # Layer-2 pure-playout nets: only below this hand size. At rem>=5 the
    # combinatorial max_p2_net often costs more than the LPs it skips, and
    # omitting it is exact (falls through to matrix / LP).
    cdef int NET_BOUNDS_MAX_K = 4
    cdef int rem = mask_sum(rem_mask)
    if sd > rem:
        return 1.0
    if sd < -rem:
        return -1.0
    if rem == 0:
        return terminal(sd)

    if h1 == 0 or h2 == 0:
        return terminal(sd)

    cdef int my_max = bit_length64(h1) - 1
    cdef int opp_max = bit_length64(h2) - 1
    cdef int my_dom = 0
    cdef int opp_dom = 0
    cdef uint64_t m = h1
    cdef uint64_t bit
    cdef int g1, g2, lo, hi, m_net, m_swap

    while m:
        bit = lowest_bit(m)
        if ctz64(bit) > opp_max:
            my_dom += 1
        m ^= bit
    m = h2
    while m:
        bit = lowest_bit(m)
        if ctz64(bit) > my_max:
            opp_dom += 1
        m ^= bit

    g1 = sum_d_largest(rem_mask, n, my_dom) if my_dom else 0
    g2 = sum_d_largest(rem_mask, n, opp_dom) if opp_dom else 0
    lo = sd + 2 * g1 - rem
    hi = sd + rem - 2 * g2
    if lo > 0:
        return 1.0
    if hi < 0:
        return -1.0
    if lo == 0 and hi == 0:
        return 0.0

    if not have_rp:
        return FORCED_NONE
    if popcount64(h1) > NET_BOUNDS_MAX_K:
        return FORCED_NONE

    net_bounds(h1, h2, rest, pending, n, &m_net, &m_swap)
    if sd > m_net:
        return 1.0
    if sd < -m_swap:
        return -1.0
    if m_net == -m_swap and sd == m_net:
        return 0.0
    return FORCED_NONE


cdef int only_bit(uint64_t mask, int n) noexcept nogil:
    cdef int b
    for b in range(n):
        if mask & (<uint64_t>1 << b):
            return b
    return -1


cdef double value_k1(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending, int sd, int n
) noexcept nogil:
    cdef int b1 = only_bit(h1, n)
    cdef int b2 = only_bit(h2, n)
    cdef int v1 = b1 + 1
    cdef int v2 = b2 + 1
    cdef double total
    cdef int cnt, b, stake
    cdef uint64_t bit

    if pending == 0:
        total = 0.0
        cnt = 0
        for b in range(n):
            bit = <uint64_t>1 << b
            if rest & bit:
                total += value_k1(h1, h2, rest ^ bit, bit, sd, n)
                cnt += 1
        return total / cnt if cnt else terminal(sd)

    stake = mask_sum(pending)
    if v1 > v2:
        return terminal(sd + stake)
    if v1 < v2:
        return terminal(sd - stake)
    if rest == 0:
        return terminal(sd)
    total = 0.0
    cnt = 0
    for b in range(n):
        bit = <uint64_t>1 << b
        if rest & bit:
            total += value_k1(h1, h2, rest ^ bit, pending | bit, sd, n)
            cnt += 1
    return total / cnt


# ---------------------------------------------------------------------------
# Inlined matrix-game value (stack buffer; no NumPy / Numba on hot path)
# ---------------------------------------------------------------------------

cdef double solve_2x2(double a, double b, double c, double d) noexcept nogil:
    cdef double row0_min = a if a < b else b
    cdef double row1_min = c if c < d else d
    cdef double maximin = row0_min if row0_min > row1_min else row1_min
    cdef double col0_max = a if a > c else c
    cdef double col1_max = b if b > d else d
    cdef double minimax = col0_max if col0_max < col1_max else col1_max
    cdef double denom, value
    if maximin >= minimax - 1e-10:
        return maximin
    denom = a - b - c + d
    if denom > -1e-12 and denom < 1e-12:
        return 0.5 * (maximin + minimax)
    value = (a * d - b * c) / denom
    if value < maximin - 1e-9:
        return maximin
    if value > minimax + 1e-9:
        return minimax
    return value


cdef double simplex_min_small(
    double* c, double* A, double* b, int n, int m
) noexcept nogil:
    """Minimize c^T x s.t. A x >= b, x >= 0. n,m <= 13 (full GOPS hand)."""
    # total_vars = n + 2*m <= 13+26=39; cols<=40; rows<=14 → 14*40=560
    cdef double tableau[560]
    cdef int basis[13]
    cdef int i, j, entering, leaving
    cdef double BIG_M = 1e8
    cdef double best_rc, best_ratio, rc, ratio, piv, factor
    cdef int total_vars = n + 2 * m
    cdef int cols = total_vars + 1
    cdef int rows = m + 1

    for i in range(rows * cols):
        tableau[i] = 0.0

    for i in range(m):
        for j in range(n):
            tableau[i * cols + j] = A[i * n + j]
        tableau[i * cols + n + i] = -1.0
        tableau[i * cols + n + m + i] = 1.0
        tableau[i * cols + total_vars] = b[i]

    for j in range(n):
        tableau[m * cols + j] = c[j]
    for j in range(m):
        tableau[m * cols + n + m + j] = BIG_M

    for i in range(m):
        for j in range(cols):
            tableau[m * cols + j] -= BIG_M * tableau[i * cols + j]

    for i in range(m):
        basis[i] = n + m + i

    for _ in range(10000):
        entering = -1
        best_rc = -1e-9
        for j in range(total_vars):
            rc = tableau[m * cols + j]
            if rc < best_rc:
                best_rc = rc
                entering = j
        if entering < 0:
            break

        leaving = -1
        best_ratio = 1e300
        for i in range(m):
            piv = tableau[i * cols + entering]
            if piv > 1e-12:
                ratio = tableau[i * cols + total_vars] / piv
                if ratio < best_ratio:
                    best_ratio = ratio
                    leaving = i
        if leaving < 0:
            return -1e20

        piv = tableau[leaving * cols + entering]
        for j in range(cols):
            tableau[leaving * cols + j] /= piv
        for i in range(rows):
            if i == leaving:
                continue
            factor = tableau[i * cols + entering]
            if factor != 0.0:
                for j in range(cols):
                    tableau[i * cols + j] -= factor * tableau[leaving * cols + j]
        basis[leaving] = entering

    for i in range(m):
        if basis[i] >= n + m and tableau[i * cols + total_vars] > 1e-6:
            return 1e20
    return tableau[m * cols + total_vars]


cdef double matrix_value_buf(double* M, int nrows, int ncols) noexcept nogil:
    cdef int i, j
    cdef double best, row_min, col_max, maximin, minimax, min_val, shift, opt_sum
    cdef double c[13]
    cdef double A[169]
    cdef double bb[13]

    _ST.matrix += 1

    if nrows == 1:
        _ST.m_pure += 1
        best = M[0]
        for j in range(1, ncols):
            if M[j] < best:
                best = M[j]
        return best
    if ncols == 1:
        _ST.m_pure += 1
        best = M[0]
        for i in range(1, nrows):
            if M[i * ncols] > best:
                best = M[i * ncols]
        return best

    maximin = -1e20
    for i in range(nrows):
        row_min = M[i * ncols]
        for j in range(1, ncols):
            if M[i * ncols + j] < row_min:
                row_min = M[i * ncols + j]
        if row_min > maximin:
            maximin = row_min

    minimax = 1e20
    for j in range(ncols):
        col_max = M[j]
        for i in range(1, nrows):
            if M[i * ncols + j] > col_max:
                col_max = M[i * ncols + j]
        if col_max < minimax:
            minimax = col_max

    if maximin >= minimax - 1e-9:
        _ST.m_pure += 1
        return maximin

    if nrows == 2 and ncols == 2:
        _ST.m_2x2 += 1
        return solve_2x2(M[0], M[1], M[2], M[3])

    # Exact LP for all remaining sizes (up to 13x13 for full N).
    if nrows > 13 or ncols > 13:
        _ST.m_approx += 1
        return 0.5 * (maximin + minimax)

    _ST.m_lp += 1
    min_val = M[0]
    for i in range(nrows):
        for j in range(ncols):
            if M[i * ncols + j] < min_val:
                min_val = M[i * ncols + j]
    shift = 1.0 - min_val

    for i in range(nrows):
        c[i] = 1.0
    for i in range(nrows):
        for j in range(ncols):
            A[j * nrows + i] = M[i * ncols + j] + shift
    for j in range(ncols):
        bb[j] = 1.0

    opt_sum = -simplex_min_small(c, A, bb, nrows, ncols)
    if opt_sum <= 1e-10 or opt_sum >= 1e19:
        _ST.m_approx += 1
        return 0.5 * (maximin + minimax)
    return 1.0 / opt_sum - shift


# ---------------------------------------------------------------------------
# Core DP
# ---------------------------------------------------------------------------

cdef double value_c(
    int n,
    FloatMap cache,
    FloatMap forced_cache,
    uint64_t h1,
    uint64_t h2,
    uint64_t rest,
    uint64_t pending,
    int sd,
):
    cdef double sign = 1.0
    cdef uint64_t nh1, nh2, rem_mask, bit, bit_i, bit_j, h1n, h2n, prizes, rm, pbit, m1, m2
    cdef uint64_t tmp
    cdef int64_t key
    cdef double forced, total, v, acc, hit
    cdef int cnt, km, ko, stake, bi, bj, vi, vj, sdn, i, j
    cdef double payoff[169]  # up to 13x13

    _ST.visits += 1

    if popcount64(h1) == 1:
        _ST.k1 += 1
        return value_k1(h1, h2, rest, pending, sd, n)

    normalize_hands(h1, h2, n, &nh1, &nh2)
    if nh1 > nh2:
        tmp = h1
        h1 = h2
        h2 = tmp
        tmp = nh1
        nh1 = nh2
        nh2 = tmp
        sd = -sd
        sign = -1.0

    if nh1 == nh2:
        if sd == 0:
            _ST.sym0 += 1
            return 0.0
        if sd < 0:
            sd = -sd
            sign = -sign

    key = pack_key(nh1, nh2, rest, pending, sd)
    if cache._lookup(key, &hit):
        _ST.cache_hit += 1
        return sign * hit
    if forced_cache._lookup(key, &hit):
        _ST.cache_hit += 1
        return sign * hit
    if plateau_lookup(nh1, nh2, rest, pending, sd, &hit):
        _ST.plateau += 1
        return sign * hit

    rem_mask = rest if pending == 0 else (rest | pending)
    forced = forced_wl(h1, h2, rem_mask, n, sd, rest, pending, True)
    if forced != FORCED_NONE:
        _ST.forced += 1
        forced_cache.set_c(key, forced)
        return sign * forced

    # Piecewise step V(sd) from on-disk knots (after forced misses).
    if piecewise_lookup(nh1, nh2, rest, pending, sd, &hit):
        _ST.piecewise += 1
        return sign * hit

    if pending == 0:
        if h1 == 0:
            v = terminal(sd)
            commit_value(cache, key, nh1, nh2, rest, pending, sd, v)
            return sign * v

        total = 0.0
        cnt = 0
        prizes = rest
        while prizes:
            bit = lowest_bit(prizes)
            total += value_c(n, cache, forced_cache, h1, h2, rest ^ bit, bit, sd)
            cnt += 1
            prizes ^= bit
        v = total / cnt
        commit_value(cache, key, nh1, nh2, rest, pending, sd, v)
        return sign * v

    km = popcount64(h1)
    ko = popcount64(h2)
    stake = mask_sum(pending)

    i = 0
    m1 = h1
    while m1:
        bit_i = lowest_bit(m1)
        bi = ctz64(bit_i)
        h1n = h1 ^ bit_i
        vi = bi + 1
        j = 0
        m2 = h2
        while m2:
            bit_j = lowest_bit(m2)
            bj = ctz64(bit_j)
            h2n = h2 ^ bit_j
            vj = bj + 1
            if vi != vj:
                sdn = sd + stake if vi > vj else sd - stake
                payoff[i * ko + j] = value_c(
                    n, cache, forced_cache, h1n, h2n, rest, 0, sdn
                )
            else:
                if rest == 0:
                    payoff[i * ko + j] = terminal(sd)
                else:
                    acc = 0.0
                    cnt = 0
                    rm = rest
                    while rm:
                        pbit = lowest_bit(rm)
                        acc += value_c(
                            n, cache, forced_cache,
                            h1n, h2n, rest ^ pbit, pending | pbit, sd,
                        )
                        cnt += 1
                        rm ^= pbit
                    payoff[i * ko + j] = acc / cnt
            j += 1
            m2 ^= bit_j
        i += 1
        m1 ^= bit_i

    v = matrix_value_buf(payoff, km, ko)
    commit_value(cache, key, nh1, nh2, rest, pending, sd, v)
    return sign * v


cdef void store_canonical_c(
    int n,
    FloatMap cache,
    uint64_t h1,
    uint64_t h2,
    uint64_t rest,
    uint64_t pending,
    int sd,
    double v_original,
):
    """
    Store Nash value for (h1,h2,rest,pending,sd) using the same key
    canonicalization as value_c. ``v_original`` is the P1 value in the
    *input* orientation (what ``value`` returns). ±1 become plateaus.
    """
    cdef double sign = 1.0
    cdef uint64_t nh1, nh2, tmp
    cdef int64_t key
    cdef double cached

    if popcount64(h1) == 1:
        return  # k=1 never memoized

    normalize_hands(h1, h2, n, &nh1, &nh2)
    if nh1 > nh2:
        tmp = h1
        h1 = h2
        h2 = tmp
        tmp = nh1
        nh1 = nh2
        nh2 = tmp
        sd = -sd
        sign = -1.0

    if nh1 == nh2:
        if sd == 0:
            return  # V=0 by symmetry; nothing to store
        if sd < 0:
            sd = -sd
            sign = -sign

    key = pack_key(nh1, nh2, rest, pending, sd)
    cached = sign * v_original
    commit_value(cache, key, nh1, nh2, rest, pending, sd, cached)


cpdef void store_value(
    int n,
    FloatMap cache,
    FloatMap forced_cache,
    int64_t h1,
    int64_t h2,
    int64_t rest,
    int64_t pending,
    int sd,
    double v_original,
):
    store_canonical_c(
        n, cache,
        <uint64_t>h1, <uint64_t>h2, <uint64_t>rest, <uint64_t>pending,
        sd, v_original,
    )


cpdef int seed_shell_monotone(
    int n,
    FloatMap cache,
    FloatMap forced_cache,
    int64_t h1,
    int64_t h2,
    int64_t rest,
    int64_t pending,
    object sd_list,
):
    """
    Seed undecided score diffs for one face-up shell.

    Binary-searches ±1 plateaus (stored as compact per-shell thresholds —
    not one cache entry per sd). Fully solves / stores only the fractional
    band. Returns number of undecided sds covered.
    """
    cdef list und = sorted(sd_list)
    cdef list und_c
    cdef Py_ssize_t n_und, i, lo, hi, mid, first_plus, last_minus
    cdef double v
    cdef int sd, lm_sd, fp_sd
    cdef uint64_t nh1, nh2, ch1, ch2, tmp
    cdef bint flipped = False

    n_und = len(und)
    if n_und == 0:
        return 0

    # Work in the same canonical orientation as value_c (nh1 <= nh2).
    ch1 = <uint64_t>h1
    ch2 = <uint64_t>h2
    normalize_hands(ch1, ch2, n, &nh1, &nh2)
    if nh1 > nh2:
        tmp = ch1
        ch1 = ch2
        ch2 = tmp
        tmp = nh1
        nh1 = nh2
        nh2 = tmp
        flipped = True

    if flipped:
        und_c = sorted([-<int>s for s in und])
    else:
        und_c = und

    if nh1 == nh2:
        # Equal-hand mirror: keep sd > 0 only.
        und_c = [s for s in und_c if s > 0]
        n_und = len(und_c)
        if n_und == 0:
            return 0

    n_und = len(und_c)

    # Smallest index with V ≈ +1 (or n_und if none).
    lo = 0
    hi = n_und
    while lo < hi:
        mid = (lo + hi) // 2
        sd = <int>und_c[mid]
        v = value_c(n, cache, forced_cache, ch1, ch2, <uint64_t>rest, <uint64_t>pending, sd)
        if v >= 1.0 - VAL_EPS:
            hi = mid
        else:
            lo = mid + 1
    first_plus = lo

    # Largest index with V ≈ -1 (or -1 if none).
    lo = -1
    hi = n_und - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        sd = <int>und_c[mid]
        v = value_c(n, cache, forced_cache, ch1, ch2, <uint64_t>rest, <uint64_t>pending, sd)
        if v <= -1.0 + VAL_EPS:
            lo = mid
        else:
            hi = mid - 1
    last_minus = lo

    if last_minus >= first_plus:
        for i in range(n_und):
            sd = <int>und_c[i]
            value_c(n, cache, forced_cache, ch1, ch2, <uint64_t>rest, <uint64_t>pending, sd)
        return <int>len(und)

    lm_sd = <int>und_c[last_minus] if last_minus >= 0 else SD_NONE
    fp_sd = <int>und_c[first_plus] if first_plus < n_und else SD_NONE
    plateau_set(nh1, nh2, <uint64_t>rest, <uint64_t>pending, lm_sd, fp_sd)

    # Fully solve the fractional band only (plateaus live in _PLATEAU).
    for i in range(last_minus + 1, first_plus):
        sd = <int>und_c[i]
        value_c(n, cache, forced_cache, ch1, ch2, <uint64_t>rest, <uint64_t>pending, sd)

    return <int>len(und)


# --- Python-facing API -----------------------------------------------------

cpdef void clear_dominance_memos():
    _NET_MEMO.clear_c()
    _NET_BOUNDS.clear_c()
    _PLATEAU.clear_c()


# Piecewise V(sd): shell_key -> (sds_tuple, vs_tuple) of change-points only.
# Lookup after forced_wl: rightmost knot with knot_sd <= query_sd (step function).
cdef object _PIECEWISE = None


cpdef void clear_piecewise():
    global _PIECEWISE
    _PIECEWISE = None


cpdef void load_piecewise(object mapping):
    """mapping: {shell_key: (sds_sequence, vs_sequence)} sorted by sd."""
    global _PIECEWISE
    _PIECEWISE = mapping


cpdef object export_piecewise():
    return _PIECEWISE


cpdef int piecewise_shell_count():
    if _PIECEWISE is None:
        return 0
    return <int>len(_PIECEWISE)


cpdef int piecewise_knot_count():
    if _PIECEWISE is None:
        return 0
    cdef int n = 0
    cdef object sds
    for sds, _vs in _PIECEWISE.values():
        n += <int>len(sds)
    return n


cdef bint piecewise_lookup(
    uint64_t h1, uint64_t h2, uint64_t rest, uint64_t pending, int sd,
    double* out_v,
):
    if _PIECEWISE is None:
        return False
    cdef object item = _PIECEWISE.get(pack_shell(h1, h2, rest, pending))
    if item is None:
        return False
    cdef object sds = item[0]
    cdef object vs = item[1]
    cdef Py_ssize_t n = len(sds)
    if n == 0:
        return False
    # Rightmost index with sds[i] <= sd (step holds through the next change).
    cdef Py_ssize_t lo = 0
    cdef Py_ssize_t hi = n
    cdef Py_ssize_t mid
    while lo < hi:
        mid = (lo + hi) // 2
        if <int>sds[mid] <= sd:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0:
        return False
    out_v[0] = <double>vs[lo - 1]
    return True


cpdef dict export_plateaus():
    cdef dict out = {}
    cdef Py_ssize_t i
    for i in range(_PLATEAU.n_buckets):
        if _PLATEAU._state[i] == FILLED:
            out[_PLATEAU._keys[i]] = _PLATEAU._vals[i]
    return out


cpdef void load_plateaus(object mapping):
    cdef object k, v
    _PLATEAU.clear_c()
    for k, v in mapping.items():
        _PLATEAU.set_c(<int64_t>k, <int64_t>v)


cpdef int plateau_count():
    return <int>_PLATEAU.n_items


cpdef tuple normalize_hands_py(int64_t h1, int64_t h2, int n):
    cdef uint64_t oh1, oh2
    normalize_hands(<uint64_t>h1, <uint64_t>h2, n, &oh1, &oh2)
    return <int64_t>oh1, <int64_t>oh2


cpdef int mask_sum_py(int64_t mask, int n):
    return mask_sum(<uint64_t>mask)


cpdef int sum_d_largest_py(int64_t mask, int n, int d):
    return sum_d_largest(<uint64_t>mask, n, d)


cpdef tuple net_bounds_py(int64_t h1, int64_t h2, int64_t rest, int64_t pending, int n):
    cdef int m, m_swap
    net_bounds(<uint64_t>h1, <uint64_t>h2, <uint64_t>rest, <uint64_t>pending, n, &m, &m_swap)
    return m, m_swap


cpdef object forced_wl_py(
    int64_t h1, int64_t h2, int64_t rem_mask, int n, int sd,
    object rest=None, object pending=None,
):
    cdef bint have_rp = rest is not None and pending is not None
    cdef uint64_t r = <uint64_t>rest if have_rp else 0
    cdef uint64_t p = <uint64_t>pending if have_rp else 0
    cdef double v = forced_wl(
        <uint64_t>h1, <uint64_t>h2, <uint64_t>rem_mask, n, sd, r, p, have_rp
    )
    if v == FORCED_NONE:
        return None
    return v


cpdef double value_k1_py(
    int64_t h1, int64_t h2, int64_t rest, int64_t pending, int sd, int n
):
    return value_k1(
        <uint64_t>h1, <uint64_t>h2, <uint64_t>rest, <uint64_t>pending, sd, n
    )


cpdef double value(
    int n,
    FloatMap cache,
    FloatMap forced_cache,
    int64_t h1,
    int64_t h2,
    int64_t rest,
    int64_t pending,
    int sd,
):
    return value_c(
        n, cache, forced_cache,
        <uint64_t>h1, <uint64_t>h2, <uint64_t>rest, <uint64_t>pending, sd,
    )
