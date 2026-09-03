/** Vite が Worker を同梱アセットの URL として解決するための型宣言。 */
declare module "*?worker&url" {
  const workerURL: string;
  export default workerURL;
}
