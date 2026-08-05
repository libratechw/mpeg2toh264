import numpy as np
np.set_printoptions(precision=4, suppress=True, linewidth=200)

# H.264 normAdjust8x8 (spec 8-317), v8x8 table
v8 = np.array([
 [20,18,32,19,25,24],
 [22,19,35,21,28,26],
 [26,23,42,24,33,31],
 [28,25,45,26,35,33],
 [32,28,51,30,40,38],
 [36,32,58,34,46,43]], float)

def cls(i,j):
    if i%4==0 and j%4==0: return 0
    if i%2==1 and j%2==1: return 1
    if i%4==2 and j%4==2: return 2
    if (i%4==0 and j%2==1) or (i%2==1 and j%4==0): return 3
    if (i%4==0 and j%4==2) or (i%4==2 and j%4==0): return 4
    return 5

normAdj = np.zeros((6,8,8))
for m in range(6):
    for i in range(8):
        for j in range(8):
            normAdj[m,i,j] = v8[m, cls(i,j)]

# H.264 8x8 forward transform row norms -> the basis scaling the ICT introduces
Cf8 = np.array([
    [ 8,  8,  8,  8,  8,  8,  8,  8],
    [12, 10,  6,  3, -3, -6,-10,-12],
    [ 8,  4, -4, -8, -8, -4,  4,  8],
    [10, -3,-12, -6,  6, 12,  3,-10],
    [ 8, -8, -8,  8,  8, -8, -8,  8],
    [ 6,-12,  3, 10,-10, -3, 12, -6],
    [ 4, -8,  8, -4, -4,  8, -8,  4],
    [ 3, -6, 10,-12, 12,-10,  6, -3]], float)
n = np.linalg.norm(Cf8, axis=1)          # per-row norm of the integer transform
outer = np.outer(n, n)                    # per-coefficient gain vs orthonormal DCT

print("=== Does normAdjust8x8 compensate exactly the ICT basis gain? ===")
for m in range(6):
    r = normAdj[m] * outer
    print(f"m={m}: (normAdjust*rownorm_gain) spread = {r.max()/r.min():.6f}   mean={r.mean():.1f}")

print("\n--> if spread == 1.0, normAdjust IS the basis-norm compensation,")
print("    so weightScale8x8 is a *pure* per-coefficient quant matrix, exactly like MPEG-2's W.\n")

# MPEG-2 quantiser_scale (linear, q_scale_type=0) vs H.264 QP step (logarithmic)
mpeg2_qs = np.arange(1, 32) * 2          # quantiser_scale_code 1..31 -> qs = 2*code
h264_step = 2.0 ** (np.arange(0, 52)/6.0)

print("=== MPEG-2 quantiser_scale -> best H.264 QP (step ratio = requant penalty) ===")
worst = 0
for qs in mpeg2_qs:
    target = qs / 16.0                    # MPEG-2 effective step factor (W applied separately)
    # pick finest QP whose step <= target (never coarser than source)
    cand = np.where(h264_step/ h264_step[0] * (2.0**(0/6)) <= target/ (target/ (qs/16.0)) , 0, 0)
    ratios = target / (h264_step * (mpeg2_qs[0]/16.0) / h264_step[0])
    qp = int(np.max(np.where(ratios >= 1.0)[0])) if np.any(ratios >= 1.0) else 0
    r = ratios[qp]
    worst = max(worst, r)
    if qs in (2, 8, 16, 32, 62):
        print(f"  qs={qs:3d}  -> QP={qp:2d}  level rescale ratio = {r:.4f}")
print(f"\nworst-case level rescale ratio over all quantiser_scale = {worst:.4f}")
print(f"(ratio 1.0 = levels pass through untouched; {2**(1/6):.4f} = one full QP step)")
