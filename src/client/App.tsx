import { useLocation } from './lib/router';
import { Landing } from './screens/Landing';
import { Play } from './screens/Play';
import { Host } from './screens/Host';
import { Display } from './screens/Display';

export function App() {
  const [location, navigate] = useLocation();
  const code = (location.query.get('code') ?? '').toUpperCase();

  switch (location.path) {
    case '/play':
      return <Play navigate={navigate} code={code} />;
    case '/host':
      return <Host navigate={navigate} code={code} />;
    case '/display':
      return <Display navigate={navigate} code={code} />;
    default:
      return <Landing navigate={navigate} initialCode={code} />;
  }
}
