import { Link } from 'react-router-dom';
export default function NotFound() {
  return (
    <div className="container narrow center">
      <p className="eyebrow">Error 404</p>
      <h1 className="display sm">This page is not in the queue.</h1>
      <p className="lead">The link may be old or mistyped. You can head back and join a queue from the home page.</p>
      <Link className="btn" to="/">Back to home</Link>
    </div>
  );
}
