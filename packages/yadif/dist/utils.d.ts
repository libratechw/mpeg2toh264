/** One triangle over the whole viewport: every pixel is the fragment shader's. */
export declare const VERTEX_SHADER = "#version 300 es\nvoid main() {\n  // From the vertex index alone. There is no geometry here worth a buffer.\n  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);\n  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);\n}\n";
export declare function createProgram(gl: WebGL2RenderingContext, fragmentSource: string, vertexSource: string): WebGLProgram;
export declare function compile(gl: WebGL2RenderingContext, kind: GLenum, source: string): WebGLShader;
//# sourceMappingURL=utils.d.ts.map