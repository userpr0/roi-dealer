import { describe, expect, it } from 'vitest';
import { htmlToText } from '@roi-dealer/evidence';

describe('htmlToText', () => {
  it('turns Hacker News item HTML into plain text', () => {
    const html =
      'I&#x27;m tired of invoicing &amp; chasing payments.<p>We tried <a href="https://example.com/tool" rel="nofollow">https:&#x2F;&#x2F;example.com&#x2F;tool</a> &gt; it failed.<p><i>Any ideas?</i>';
    expect(htmlToText(html)).toBe(
      "I'm tired of invoicing & chasing payments.\n\nWe tried https://example.com/tool > it failed.\n\nAny ideas?",
    );
  });

  it('keeps escaped markup as text and drops real tags', () => {
    expect(htmlToText('&lt;b&gt;not bold&lt;/b&gt; <b>bold</b><br>next')).toBe(
      '<b>not bold</b> bold\nnext',
    );
  });

  it('collapses whitespace and leaves unknown references alone', () => {
    expect(htmlToText('  a&nbsp;&nbsp; b <p><p><p> c &unknown; &#0;')).toBe(
      'a b\n\nc &unknown; &#0;',
    );
  });
});
