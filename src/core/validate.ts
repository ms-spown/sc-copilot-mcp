/** "owner/name" for a GitHub repository, with no way to climb out of the path ("." and ".." refused). */
export function isRepoName(value: string): boolean {
  const part = /^[A-Za-z0-9_.-]+$/;
  const [owner, name, ...rest] = value.split("/");
  return (
    rest.length === 0 &&
    owner !== undefined &&
    name !== undefined &&
    part.test(owner) &&
    part.test(name) &&
    ![owner, name].some((p) => p === "." || p === "..")
  );
}
