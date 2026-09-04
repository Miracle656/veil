import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from '@remix-run/react'
import { getPublicEnv } from '~/lib/config.server'
import { globalStyles } from '~/styles'

export function loader() {
  // Expose only the public (non-secret) env to the browser.
  return { ENV: getPublicEnv() }
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Veil Wallet — Remix</title>
        <Meta />
        <Links />
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  const { ENV } = useLoaderData<typeof loader>()
  return (
    <>
      {/* Inject the public env so client code can read window.ENV. */}
      <script
        dangerouslySetInnerHTML={{ __html: `window.ENV = ${JSON.stringify(ENV)}` }}
      />
      <Outlet />
    </>
  )
}
