export function buildCanvasHtml(port: number, devOrigin: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Popmelt Canvas</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box}html,body,#root{height:100%;overflow:hidden}</style>
</head>
<body>
  <div id="root"></div>
  <script type="importmap">
  {"imports":{
    "react":"https://esm.sh/react@19?dev",
    "react-dom/client":"https://esm.sh/react-dom@19/client?dev",
    "react/jsx-runtime":"https://esm.sh/react@19/jsx-runtime?dev"
  }}
  </script>
  <script type="module">
    import { mountCanvas } from 'http://localhost:${port}/canvas/app.mjs';
    mountCanvas(document.getElementById('root'), {
      devOrigin: '${devOrigin}',
      bridgeOrigin: 'http://localhost:${port}',
    });
  </script>
</body>
</html>`;
}
