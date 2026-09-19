type CharData = {
    x: number;
    y: number;
    width: number;
    height: number;
    metrics: TextMetrics;
};
export type DebugRenderState = {
    gl: WebGL2RenderingContext;
    fontTexture: WebGLTexture;
    chars: Map<string, CharData>;
    textureSize: {
        width: number;
        height: number;
    };
    program: WebGLProgram;
    programUniforms: {
        vertex: number;
        textureCoord: number;
        texture: WebGLUniformLocation;
        matrix: WebGLUniformLocation;
        uvMatrix: WebGLUniformLocation;
        textColor: WebGLUniformLocation;
        backColor: WebGLUniformLocation;
    };
    positionBuffer: WebGLBuffer;
    textureBuffer: WebGLBuffer;
};
export declare function initDebugRenderState(gl: WebGL2RenderingContext, font: string): DebugRenderState;
export declare function destroyDebugRenderState(debugRenderState: DebugRenderState): void;
export declare function drawText(debugRenderState: DebugRenderState, text: string, x: number, y: number, viewportWidth: number, viewPortHeight: number, lineHeight: number): void;
export {};
//# sourceMappingURL=debug.d.ts.map