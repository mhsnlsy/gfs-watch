import { Container } from "cloudflare:containers";

export class GfsPressureContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return env.GFS_PRESSURE_CONTAINER.fetch(new Request(new URL("/health", request.url), request));
    if (url.pathname === "/analyze" && request.method === "POST") {
      return env.GFS_PRESSURE_CONTAINER.fetch(new Request(new URL("/analyze", request.url), request));
    }
    return new Response(JSON.stringify({service:"gfs-pressure-centers",status:"ok"}), {headers:{"content-type":"application/json"}});
  }
};