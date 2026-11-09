import { Container } from "@cloudflare/containers";

export class GfsPressureContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === "/health" ||
      url.pathname === "/latest" ||
      (url.pathname === "/analyze" && request.method === "POST")
    ) {
      const container = env.GFS_PRESSURE_CONTAINER.getByName("gfs-pressure-centers");
      return container.fetch(
        new Request(new URL(url.pathname, request.url), request)
      );
    }

    return new Response(
      JSON.stringify({
        service: "gfs-pressure-centers",
        status: "ok",
        endpoints: ["/health", "/latest", "/analyze"]
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8"
        }
      }
    );
  }
};
