export function convertStorageToMarkdown(storageFormat: string): string {
  try {
    // Basic HTML-like to Markdown conversion
    let markdown = storageFormat
      // Remove XML declaration and DOCTYPE
      .replace(/<\?xml.*?\?>/, '')
      .replace(/<!DOCTYPE.*?>/, '')
      
      // Headers
      .replace(/<h1[^>]*>(.*?)<\/h1>/g, '# $1\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/g, '## $1\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/g, '### $1\n')
      .replace(/<h4[^>]*>(.*?)<\/h4>/g, '#### $1\n')
      .replace(/<h5[^>]*>(.*?)<\/h5>/g, '##### $1\n')
      .replace(/<h6[^>]*>(.*?)<\/h6>/g, '###### $1\n')
      
      // Lists
      .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/g, (match, content) => {
        return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, '* $1\n');
      })
      .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/g, (match, content) => {
        let index = 1;
        return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, () => `${index++}. $1\n`);
      })
      
      // Links
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[$2]($1)')
      
      // Emphasis
      .replace(/<strong[^>]*>(.*?)<\/strong>/g, '**$1**')
      .replace(/<em[^>]*>(.*?)<\/em>/g, '*$1*')
      
      // Code
      .replace(/<code[^>]*>(.*?)<\/code>/g, '`$1`')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, '```\n$1\n```')
      
      // Paragraphs and line breaks
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '$1\n\n')
      .replace(/<br\s*\/?>/g, '\n')
      
      // Tables (simplified)
      .replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (match: string, content: string) => {
        const rows = content.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];
        return rows.map((row: string) => {
          const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) || [];
          return cells.map((cell: string) => cell.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g, '$1').trim()).join(' | ');
        }).join('\n');
      })
      
      // Clean up
      .replace(/\n{3,}/g, '\n\n')  // Remove extra newlines
      .trim();
    
    return markdown;
  } catch (error) {
    console.error('Error converting content:', error);
    throw new Error('Failed to convert content to markdown');
  }
}
