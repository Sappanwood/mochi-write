import ReactMarkdown from "react-markdown";
export function Markdown({ text }: { text: string }) {
  return (
    <article className="markdown">
      <ReactMarkdown
        skipHtml
        urlTransform={(url) =>
          /^(https?:|mailto:)/i.test(url) || url.startsWith("#") ? url : ""
        }
        components={{
          img: () => null,
          a: ({ children, href }) =>
            href ? (
              <a
                href={href}
                rel="noreferrer noopener"
                target={href.startsWith("#") ? undefined : "_blank"}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </article>
  );
}
