import type { HttpClient } from "../../core/http.js";

/** The wiki API caps page size at 50 regardless of what is requested. */
export const SCW_MAX_PAGE_SIZE = 50;

/** Fetch every page of a paginated Star Citizen Wiki collection. */
export async function fetchAllPages(
  client: HttpClient,
  endpoint: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  let page = 1;

  for (;;) {
    const response = await client.get(endpoint, {
      // `per_page` is ignored. Page size is `page[size]`, capped at 50, and a bare
      // `page` alongside it silently voids it (PHP scalar/array conflict), so the
      // page number must also use bracket form.
      params: { ...params, "page[number]": page, "page[size]": SCW_MAX_PAGE_SIZE },
    });
    const pageData = response.data?.data;
    if (!Array.isArray(pageData) || pageData.length === 0) break;
    collected.push(...pageData);

    const lastPage = response.data?.meta?.last_page;
    if (typeof lastPage === "number") {
      if (page >= lastPage) break;
    } else if (pageData.length < SCW_MAX_PAGE_SIZE) {
      break;
    }
    page += 1;
  }

  return collected;
}
