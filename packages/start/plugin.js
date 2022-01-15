import path from "path";
import manifest from "rollup-route-manifest";
import solid from "vite-plugin-solid";
import inspect from "vite-plugin-inspect";
import { getRoutes, stringifyRoutes } from "./routes.js";
import { createDevHandler } from "./runtime/devServer.js";
import c from "picocolors";
import babel from "@babel/core";

function serverBabel(babel) {
  const { types: t, template } = babel;

  return {
    name: "ast-transform", // not required
    visitor: {
      Program(path, state) {
        state.servers = 0;
      },
      CallExpression(path, state) {
        let callee = path.get("callee");
        if (callee.get("name").node === "server") {
          const serverFn = path.get("arguments")[0];
          let program = path.findParent(p => t.isProgram(p));
          let statement = path.findParent(p => program.get("body").includes(p));
          let serverIndex = state.servers++;
          if (state.opts.ssr) {
            statement.insertBefore(
              template(`export const __serverModule${serverIndex} = (%%source%%)`)({
                source: serverFn.node
              })
            );
          } else {
            statement.insertBefore(
              template(
                `export const __serverModule${serverIndex} = (...args) => fetch('/__server', {
                  method: '${"POST"}',
                  body: JSON.stringify({
                    filename: '${state.filename}',
                    index: ${serverIndex},
                    args: args
                  }),
                  headers: {
                    'Content-Type': 'application/json',
                  },
                }).then(r => r.json())`,
                {
                  syntacticPlaceholders: true
                }
              )()
            );
          }
          path.replaceWith(t.identifier(`__serverModule${serverIndex}`));
        }
      }
    }
  };
}

/**
 * @returns {import('vite').Plugin}
 */
function solidStartRouter(options) {
  return {
    name: "solid-start-router",
    enforce: "pre",

    async transform(code, id, opts) {
      if (/.data.(ts|js)/.test(id)) {
        return babel.transformSync(code, {
          filename: id,
          presets: ["@babel/preset-typescript"],
          plugins: [[serverBabel, { ssr: opts?.ssr ?? false }]]
        });
      }
      if (code.includes("const routes = $ROUTES;")) {
        const routes = await getRoutes({
          pageExtensions: [
            "tsx",
            "jsx",
            "js",
            "ts",
            ...(options.extensions?.map(s => (Array.isArray(s) ? s[0] : s)).map(s => s.slice(1)) ??
              [])
          ]
        });

        return { code: code.replace("const routes = $ROUTES;", stringifyRoutes(routes)) };
      }
    }
  };
}

function solidStartBuild(options) {
  return {
    name: "solid-start-build",
    config(conf) {
      const regex = new RegExp(
        `(index)?(.(${[
          "tsx",
          "ts",
          "jsx",
          "js",
          ...(options.extensions?.map(e => e.slice(1)) ?? [])
        ].join("|")}))$`
      );

      const root = conf.root || process.cwd();
      return {
        build: {
          target: "esnext",
          manifest: true,
          rollupOptions: {
            plugins: [
              manifest({
                inline: false,
                merge: false,
                publicPath: "/",
                routes: file => {
                  file = file.replace(path.join(root, options.appRoot), "").replace(regex, "");
                  if (!file.includes(`/${options.routesDir}/`)) return "*"; // commons
                  return "/" + file.replace(`/${options.routesDir}/`, "");
                }
              })
            ]
          }
        }
      };
    }
  };
}

/**
 * @returns {import('vite').Plugin}
 */
function solidStartServer(options) {
  let config;
  return {
    name: "solid-start-dev",
    configureServer(vite) {
      return () => {
        remove_html_middlewares(vite.middlewares);

        vite.middlewares.use("/__server", async (req, res) => {
          let data = "";
          req.on("data", chunk => {
            data += chunk;
          });
          req.on("end", async () => {
            let args = JSON.parse(data);
            let mod = await vite.ssrLoadModule(args.filename);
            try {
              let response = await mod["__serverModule" + args.index](...args.args);
              res.write(JSON.stringify(response));
              res.end();
            } catch (e) {
              res.write("Not found");
              res.statusCode = 500;
              res.end();
            }
          });
        });

        vite.middlewares.use(createDevHandler(vite));

        // logging routes on server start
        vite.httpServer?.once("listening", async () => {
          const protocol = config.server.https ? "https" : "http";
          const port = config.server.port;
          const routes = await getRoutes({
            pageExtensions: [
              "tsx",
              "jsx",
              "js",
              "ts",
              ...(options.extensions
                ?.map(s => (Array.isArray(s) ? s[0] : s))
                .map(s => s.slice(1)) ?? [])
            ]
          });
          const label = `  > Routes: `;
          setTimeout(() => {
            // eslint-disable-next-line no-console
            console.log(
              `${label}\n${routes.pageRoutes
                .flatMap(r => (r.children ? r.children : [r]))
                .map(r => `     ${c.blue(`${protocol}://localhost:${port}${r.path}`)}`)
                .join("\n")}`
            );
          }, 0);
        });
      };
    },
    configResolved: conf => {
      config = conf;
    },
    config(conf) {
      const root = conf.root || process.cwd();
      return {
        resolve: {
          conditions: ["solid"],
          alias: [
            {
              find: "~",
              replacement: path.join(root, options.appRoot)
            }
          ]
        },
        ssr: {
          noExternal: ["solid-app-router", "solid-meta", "solid-start"]
        },
        solidOptions: options
      };
    }
  };
}

/**
 * @returns {import('vite').Plugin[]}
 */
export default function solidStart(options) {
  options = Object.assign(
    {
      adapter: "solid-start-node",
      appRoot: "src",
      routesDir: "pages",
      ssr: true,
      preferStreaming: true,
      prerenderRoutes: [],
      inspect: true
    },
    options ?? {}
  );

  return [
    options.inspect ? inspect() : undefined,
    solid({
      ...(options ?? {}),
      babel: (source, id, ssr) => ({
        plugins: [[serverBabel, { ssr }]]
      })
    }),
    solidStartRouter(options),
    solidStartServer(options),
    solidStartBuild(options)
  ].filter(Boolean);
}

/**
 * @param {import('vite').ViteDevServer['middlewares']} server
 */
function remove_html_middlewares(server) {
  const html_middlewares = [
    "viteIndexHtmlMiddleware",
    "vite404Middleware",
    "viteSpaFallbackMiddleware"
  ];
  for (let i = server.stack.length - 1; i > 0; i--) {
    if (html_middlewares.includes(server.stack[i].handle.name)) {
      server.stack.splice(i, 1);
    }
  }
}
