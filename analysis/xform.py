import numpy as np
np.set_printoptions(precision=3, suppress=True, linewidth=200)

# --- orthonormal 8-point DCT-II (MPEG-2 uses this, ideal) ---
def dct_mat(N):
    C = np.zeros((N, N))
    for k in range(N):
        for n in range(N):
            C[k, n] = np.cos((2*n+1)*k*np.pi/(2*N))
        C[k] *= np.sqrt((1 if k else 0.5)/ (N/2))
    return C

Cd8 = dct_mat(8)
Cd4 = dct_mat(4)

# --- H.264 8x8 forward integer transform (Cf8), spec 8.5.13.2 ---
Cf8 = np.array([
    [ 8,  8,  8,  8,  8,  8,  8,  8],
    [12, 10,  6,  3, -3, -6,-10,-12],
    [ 8,  4, -4, -8, -8, -4,  4,  8],
    [10, -3,-12, -6,  6, 12,  3,-10],
    [ 8, -8, -8,  8,  8, -8, -8,  8],
    [ 6,-12,  3, 10,-10, -3, 12, -6],
    [ 4, -8,  8, -4, -4,  8, -8,  4],
    [ 3, -6, 10,-12, 12,-10,  6, -3]], float)

# --- H.264 4x4 forward integer transform (Cf4) ---
Cf4 = np.array([
    [1, 1, 1, 1],
    [2, 1,-1,-2],
    [1,-1,-1, 1],
    [1,-2, 2,-1]], float)

def rownorm(M):
    return M / np.linalg.norm(M, axis=1, keepdims=True)

# A maps MPEG-2 DCT coeffs -> H.264 ICT coeffs (both row-normalized => unitary compare)
A8 = rownorm(Cf8) @ Cd8.T
A4 = rownorm(Cf4) @ Cd4.T

def report(name, A):
    d = np.abs(np.diag(A))
    off = A - np.diag(np.diag(A))
    e_tot = np.sum(A**2)
    e_off = np.sum(off**2)
    print(f"\n=== {name} ===")
    print(A)
    print(f"diag magnitudes : {d}")
    print(f"off-diag energy : {100*e_off/e_tot:.4f} %  (max |offdiag| = {np.abs(off).max():.5f})")

report("LUMA  8x8 DCT -> H.264 8x8 ICT", A8)
report("      4x4 DCT -> H.264 4x4 ICT", A4)

# --- CHROMA: MPEG-2 uses ONE 8x8 DCT; H.264 4:2:0 chroma uses FOUR 4x4 ICT ---
# Build: 8x8 IDCT -> split into 4 4x4 blocks -> 4x4 forward ICT.  Result 64x64 map.
I8 = Cd8.T                      # 8x8 inverse DCT (orthonormal)
T = np.zeros((64, 64))
Cf4n = rownorm(Cf4)
for u in range(8):
    for v in range(8):
        F = np.zeros((8, 8)); F[u, v] = 1.0
        px = I8 @ F @ I8.T                       # spatial 8x8 residual
        out = np.zeros((8, 8))
        for by in (0, 4):
            for bx in (0, 4):
                out[by:by+4, bx:bx+4] = Cf4n @ px[by:by+4, bx:bx+4] @ Cf4n.T
        T[:, u*8+v] = out.reshape(-1)

nz = np.abs(T) > 0.02
print("\n=== CHROMA  one 8x8 DCT coeff -> four 4x4 ICT coeffs ===")
print(f"avg # of significant (|c|>0.02) outputs per single input coeff: {nz.sum(axis=0).mean():.1f} / 64")
print(f"off-'diagonal' spread energy: {100*(1 - np.max(T**2, axis=0).sum()/np.sum(T**2)):.2f} %")
