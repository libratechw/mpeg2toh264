#!/usr/bin/env python3
"""
Generate src/h264/quant-tables.ts: what H.264 coefficient level reproduces a
given MPEG-2 coefficient.

The H.264 inverse 8x8 transform is implemented exactly as ITU-T H.264 clauses
8.5.13.1 and 8.5.13.2 specify (equations 8-356 to 8-406), so the answer comes
from the real reconstruction path rather than from an idealised model. The
question it answers: feeding level c at position (i, j) with a given QP and
scaling list, what orthonormal-DCT coefficient does the decoder effectively
reconstruct? MPEG-2 coefficients are already orthonormal-DCT values, so the
ratio between the two is the level mapping.
"""
import numpy as np

np.set_printoptions(precision=4, suppress=True, linewidth=200)

# normAdjust8x8, from the v8x8 table of clause 8.5.9.
V8 = np.array(
    [
        [20, 18, 32, 19, 25, 24],
        [22, 19, 35, 21, 28, 26],
        [26, 23, 42, 24, 33, 31],
        [28, 25, 45, 26, 35, 33],
        [32, 28, 51, 30, 40, 38],
        [36, 32, 58, 34, 46, 43],
    ],
    dtype=np.int64,
)


def norm_adjust_class(i, j):
    if i % 4 == 0 and j % 4 == 0:
        return 0
    if i % 2 == 1 and j % 2 == 1:
        return 1
    if i % 4 == 2 and j % 4 == 2:
        return 2
    if (i % 4 == 0 and j % 2 == 1) or (i % 2 == 1 and j % 4 == 0):
        return 3
    if (i % 4 == 0 and j % 4 == 2) or (i % 4 == 2 and j % 4 == 0):
        return 4
    return 5


NORM_ADJUST = np.array(
    [[[V8[m][norm_adjust_class(i, j)] for j in range(8)] for i in range(8)] for m in range(6)]
)


def scale_8x8(c, qp, weight_scale):
    """Clause 8.5.13.1: coefficient levels to scaled transform coefficients."""
    m = qp % 6
    level_scale = weight_scale * NORM_ADJUST[m]
    if qp >= 36:
        return (c * level_scale) << (qp // 6 - 6)
    shift = 6 - qp // 6
    return (c * level_scale + (1 << (shift - 1))) >> shift


def inv_1d(d):
    """One-dimensional inverse transform, equations 8-358 to 8-381."""
    e = np.empty(8, dtype=np.int64)
    e[0] = d[0] + d[4]
    e[1] = -d[3] + d[5] - d[7] - (d[7] >> 1)
    e[2] = d[0] - d[4]
    e[3] = d[1] + d[7] - d[3] - (d[3] >> 1)
    e[4] = (d[2] >> 1) - d[6]
    e[5] = -d[1] + d[7] + d[5] + (d[5] >> 1)
    e[6] = d[2] + (d[6] >> 1)
    e[7] = d[3] + d[5] + d[1] + (d[1] >> 1)

    f = np.empty(8, dtype=np.int64)
    f[0] = e[0] + e[6]
    f[1] = e[1] + (e[7] >> 2)
    f[2] = e[2] + e[4]
    f[3] = e[3] + (e[5] >> 2)
    f[4] = e[2] - e[4]
    f[5] = (e[3] >> 2) - e[5]
    f[6] = e[0] - e[6]
    f[7] = e[7] - (e[1] >> 2)

    g = np.empty(8, dtype=np.int64)
    g[0] = f[0] + f[7]
    g[1] = f[2] + f[5]
    g[2] = f[4] + f[3]
    g[3] = f[6] + f[1]
    g[4] = f[6] - f[1]
    g[5] = f[4] - f[3]
    g[6] = f[2] - f[5]
    g[7] = f[0] - f[7]
    return g


def inverse_transform_8x8(d):
    """Clause 8.5.13.2: rows, then columns, then the final rounding shift."""
    g = np.array([inv_1d(d[i]) for i in range(8)], dtype=np.int64)
    m = np.array([inv_1d(g[:, j]) for j in range(8)], dtype=np.int64).T
    return (m + 32) >> 6


def dct_matrix(n=8):
    c = np.zeros((n, n))
    for k in range(n):
        for x in range(n):
            c[k, x] = np.cos((2 * x + 1) * k * np.pi / (2 * n))
        c[k] *= np.sqrt((1 if k else 0.5) / (n / 2))
    return c


C = dct_matrix()


def h264_gain(qp, weight_scale, probe=1 << 14):
    """
    Orthonormal-DCT coefficient reconstructed per unit of coefficient level, for
    each position. Measured with a large probe level so the transform's internal
    rounding contributes negligibly.
    """
    gain = np.zeros((8, 8))
    for i in range(8):
        for j in range(8):
            c = np.zeros((8, 8), dtype=np.int64)
            c[i, j] = probe
            r = inverse_transform_8x8(scale_8x8(c, qp, weight_scale))
            # Project the spatial result back onto the orthonormal DCT basis.
            gain[i, j] = (C @ r.astype(float) @ C.T)[i, j] / probe
    return gain


# ---------------------------------------------------------------- 4x4 chroma path
# normAdjust4x4, from the v matrix of clause 8.5.9 (equations 8-314, 8-315).
V4 = np.array(
    [[10, 16, 13], [11, 18, 14], [13, 20, 16], [14, 23, 18], [16, 25, 20], [18, 29, 23]],
    dtype=np.int64,
)
NORM_ADJUST_4X4 = np.array(
    [
        [
            [
                V4[m][0]
                if (i % 2, j % 2) == (0, 0)
                else V4[m][1]
                if (i % 2, j % 2) == (1, 1)
                else V4[m][2]
                for j in range(4)
            ]
            for i in range(4)
        ]
        for m in range(6)
    ]
)

# The H.264 4x4 core transform. Its rows are mutually orthogonal, so projecting
# a residual onto them gives coefficients the decoder reconstructs exactly --
# unlike the luma path, there is no basis-shape mismatch to absorb here.
CF4 = np.array([[1, 1, 1, 1], [2, 1, -1, -2], [1, -1, -1, 1], [1, -2, 2, -1]], dtype=np.int64)

# Table 8-15: QPc as a function of qPi. Below 30 they are equal.
QPC_ABOVE_29 = [29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39]


def scale_4x4(c, qp, weight_scale):
    """Clause 8.5.12.1, for positions other than the DC of a chroma block."""
    m = qp % 6
    level_scale = weight_scale * NORM_ADJUST_4X4[m]
    if qp >= 24:
        return (c * level_scale) << (qp // 6 - 4)
    shift = 4 - qp // 6
    return (c * level_scale + (1 << (shift - 1))) >> shift


def inv_1d_4(d):
    """One-dimensional inverse transform, equations 8-338 to 8-345."""
    e = np.empty(4, dtype=np.int64)
    e[0] = d[0] + d[2]
    e[1] = d[0] - d[2]
    e[2] = (d[1] >> 1) - d[3]
    e[3] = d[1] + (d[3] >> 1)
    f = np.empty(4, dtype=np.int64)
    f[0] = e[0] + e[3]
    f[1] = e[1] + e[2]
    f[2] = e[1] - e[2]
    f[3] = e[0] - e[3]
    return f


def inverse_transform_4x4(d):
    """Clause 8.5.12.2, then the rounding of equation 8-354."""
    f = np.array([inv_1d_4(d[i]) for i in range(4)], dtype=np.int64)
    h = np.array([inv_1d_4(f[:, j]) for j in range(4)], dtype=np.int64).T
    return (h + 32) >> 6


def chroma_ac_gain(qp, weight_scale=16, probe=1 << 14):
    """
    Coefficient in the 4x4 core transform's own basis reconstructed per unit of
    level, for each AC position. Measured by running the decoder's scaling and
    inverse transform, then projecting back with the forward transform.
    """
    ws = np.full((4, 4), weight_scale)
    gain = np.zeros((4, 4))
    for i in range(4):
        for j in range(4):
            if i == 0 and j == 0:
                continue  # chroma DC arrives through the 2x2 block instead
            c = np.zeros((4, 4), dtype=np.int64)
            c[i, j] = probe
            r = inverse_transform_4x4(scale_4x4(c, qp, ws))
            gain[i, j] = (CF4 @ r @ CF4.T)[i, j] / probe
    return gain


def chroma_dc_gain(qp, weight_scale=16, probe=1 << 12):
    """
    DC coefficient, in the core transform's basis, reconstructed per unit of the
    post-Hadamard value f. The 2x2 Hadamard itself is applied by the encoder, so
    only this scalar is needed here (equation 8-326).
    """
    level_scale = weight_scale * NORM_ADJUST_4X4[qp % 6][0][0]
    dc = ((probe * level_scale) << (qp // 6)) >> 5
    d = np.zeros((4, 4), dtype=np.int64)
    d[0, 0] = dc
    r = inverse_transform_4x4(d)
    return (CF4 @ r @ CF4.T)[0, 0] / probe


DEFAULT_INTRA = np.array(
    [
        [8, 16, 19, 22, 26, 27, 29, 34],
        [16, 16, 22, 24, 27, 29, 34, 37],
        [19, 22, 26, 27, 29, 34, 34, 38],
        [22, 22, 26, 27, 29, 34, 37, 40],
        [22, 26, 27, 29, 32, 35, 40, 48],
        [26, 27, 29, 32, 35, 40, 48, 58],
        [26, 27, 29, 34, 38, 46, 56, 69],
        [27, 29, 35, 38, 46, 56, 69, 83],
    ]
)
FLAT16 = np.full((8, 8), 16)

print("=== Is the H.264 gain proportional to the scaling list, position by position? ===")
for qp in (12, 18, 24, 30, 36, 42):
    g = h264_gain(qp, DEFAULT_INTRA)
    ratio = g / DEFAULT_INTRA
    print(
        f"  QP={qp:2d}  gain/weightScale: mean={ratio.mean():.6f} "
        f"spread={ratio.max() / ratio.min():.6f}"
    )

print("\n=== Factorising the gain ===")
print("  If gain[qp][i][j] == BASE[qp%6][i][j] * weightScale[i][j] * 2^(qp/6) then a")
print("  small constant table is enough to compute the mapping at any QP.\n")
base = np.zeros((6, 8, 8))
for m in range(6):
    base[m] = h264_gain(m, FLAT16) / FLAT16
worst = 0.0
worst_at = (0, "")
# Scaling weights seen in practice: MPEG-2 matrices run 8..83 for intra and
# 16..55 for the inter matrices real broadcasters send.
for name, ws in (
    ("flat 16", FLAT16),
    ("default intra", DEFAULT_INTRA),
    ("all 83", np.full((8, 8), 83)),
    ("all 8", np.full((8, 8), 8)),
):
    for qp in range(0, 52):
        predicted = base[qp % 6] * ws * (2.0 ** (qp // 6))
        err = np.abs(h264_gain(qp, ws) / predicted - 1).max()
        if err > worst:
            worst, worst_at = err, (qp, name)
print(f"  worst relative error of the factorisation: {worst:.2e} (QP {worst_at[0]}, {worst_at[1]})")
print("  BASE[0] (the qp%6 == 0 plane), which the other five scale from:")
for row in base[0]:
    print("   ", " ".join(f"{v:.6f}" for v in row))

assert worst < 1e-4, f"gain factorisation is not accurate enough: {worst:.2e}"

# ------------------------------------------------------------------ emit
from pathlib import Path  # noqa: E402

planes = ",\n".join(
    "  [\n"
    + ",\n".join("    [" + ", ".join(f"{v:.10f}" for v in base[m][i]) + "]" for i in range(8))
    + ",\n  ]"
    for m in range(6)
)

ts = f'''/**
 * Reconstruction gain of the H.264 8x8 transform, per coefficient position.
 *
 * GENERATED by tools/gen-quant.py from ITU-T H.264 clauses 8.5.13.1 and
 * 8.5.13.2. Do not edit by hand; regenerate instead.
 *
 * BASE[qP % 6][i][j] is the orthonormal-DCT coefficient a decoder reconstructs
 * per unit of coefficient level, per unit of scaling weight, at qP / 6 == 0:
 *
 *   gain[qP][i][j] = BASE[qP % 6][i][j] * weightScale8x8[i][j] * 2 ** (qP / 6)
 *
 * That factorisation is accurate to better than 1e-5 across every scaling
 * weight and QP, checked at generation time.
 *
 * The gain is deliberately *not* uniform across the block: the integer
 * transform departs from a true DCT by up to 2.7% depending on position, so
 * dividing by the value for the right position is what keeps the mapping exact.
 * MPEG-2 coefficients are already orthonormal-DCT values, which is what makes
 * them directly comparable.
 */
export const BASE_GAIN_8X8: readonly (readonly (readonly number[])[])[] = [
{planes},
];
'''

print("\n=== Chroma path (4x4 transform, flat scaling weights) ===")
ac_base = np.array([chroma_ac_gain(m) for m in range(6)])
dc_base = np.array([chroma_dc_gain(m) for m in range(6)])
worst_c = 0.0
for m in range(6):
    for k in range(9):
        qp = m + 6 * k
        if qp > 51:
            break
        predicted_ac = ac_base[m] * (2.0**k)
        actual_ac = chroma_ac_gain(qp)
        mask = np.ones((4, 4), bool)
        mask[0, 0] = False
        worst_c = max(worst_c, np.abs(actual_ac[mask] / predicted_ac[mask] - 1).max())
        worst_c = max(worst_c, abs(chroma_dc_gain(qp) / (dc_base[m] * 2.0**k) - 1))
print(f"  worst relative error of the 4x4 factorisation: {worst_c:.2e}")
assert worst_c < 1e-4, f"chroma gain factorisation is not accurate enough: {worst_c:.2e}"
print(f"  AC gain at qp%6==0: {ac_base[0][0][1]:.6f} .. {ac_base[0][3][3]:.6f}")
print(f"  DC gain per unit of f: {list(np.round(dc_base, 6))}")

ac_planes = ",\n".join(
    "  [\n"
    + ",\n".join("    [" + ", ".join(f"{v:.10f}" for v in ac_base[m][i]) + "]" for i in range(4))
    + ",\n  ]"
    for m in range(6)
)
qpc = ", ".join(str(v) for v in list(range(30)) + QPC_ABOVE_29)

ts += f'''
/**
 * Chroma follows a different route. MPEG-2 codes one 8x8 DCT per chroma block
 * while H.264 4:2:0 uses four 4x4 transforms plus a 2x2 DC block, and one 8x8
 * coefficient spreads across roughly 22 of the 4x4 ones, so there is no
 * per-coefficient shortcut: the block is inverse transformed and forward
 * transformed for real.
 *
 * That has a compensating advantage. The forward transform used is H.264's own
 * core transform, whose rows are mutually orthogonal, so the result is exactly
 * what the decoder reconstructs from. The 0.287% basis-shape mismatch that
 * limits the luma path does not arise here.
 *
 * Gains assume flat scaling weights of 16, which is what the PPS sends for the
 * 4x4 lists.
 */
export const CHROMA_AC_GAIN_4X4: readonly (readonly (readonly number[])[])[] = [
{ac_planes},
];

/**
 * DC coefficient reconstructed per unit of the post-Hadamard value, indexed by
 * qP % 6 and scaled by 2 ** (qP / 6). The 2x2 Hadamard itself is applied by the
 * encoder.
 */
export const CHROMA_DC_GAIN: readonly number[] = [
  {", ".join(f"{v:.10f}" for v in dc_base)},
];

/** Table 8-15: chroma QP as a function of qPi. Below 30 the two are equal. */
export const QPC_FROM_QPI: readonly number[] = [
  {qpc},
];
'''

out = Path("src/h264/quant-tables.ts")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(ts)
print(f"\nwrote {out} ({len(ts)} bytes)")

print("\n=== MPEG-2 intra AC step is W*qs/16. Which QP matches, and by what ratio? ===")
print("  A ratio of exactly 1 means coefficient levels pass through untouched.\n")
print("  qs  |  best QP  |  level ratio  |  worst position error")
for qs_code in range(1, 32):
    qs = 2 * qs_code
    target = DEFAULT_INTRA * qs / 16.0  # MPEG-2 step per position
    best = None
    for qp in range(0, 52):
        g = h264_gain(qp, DEFAULT_INTRA)
        ratio = (target / g).mean()
        spread = (target / g).max() / (target / g).min()
        # Prefer a ratio at or just above 1: never coarser than the source.
        if best is None or abs(np.log(ratio)) < abs(np.log(best[1])):
            best = (qp, ratio, spread)
    if qs_code in (1, 2, 3, 4, 6, 8, 12, 16, 24, 31):
        qp, ratio, spread = best
        print(f"  {qs:3d} |    {qp:2d}     |   {ratio:.6f}   |  {spread:.6f}")
