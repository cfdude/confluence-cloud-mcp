export function convertStorageToMarkdown(storageFormat: string): string {
  try {
    // First handle Confluence-specific elements
    let markdown = storageFormat
      // Remove XML declaration and DOCTYPE
      .replace(/<\?xml.*?\?>/, '')
      .replace(/<!DOCTYPE.*?>/, '')

      // Handle Confluence layouts
      .replace(/<ac:layout[^>]*>[\s\S]*?<\/ac:layout>/g, (match) => {
        return match
          // Extract content from layout cells
          .replace(/<ac:layout-cell[^>]*>([\s\S]*?)<\/ac:layout-cell>/g, '$1\n\n')
          // Remove layout tags
          .replace(/<\/?ac:layout[^>]*>/g, '')
          .replace(/<\/?ac:layout-section[^>]*>/g, '');
      })

      // Handle Confluence macros
      .replace(/<ac:structured-macro[^>]*?ac:name="([^"]*)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, 
        (match, macroName, content) => {
          // Extract macro parameters
          const params: string[] = content.match(/<ac:parameter[^>]*?ac:name="([^"]*)"[^>]*>([\s\S]*?)<\/ac:parameter>/g) || [];
          const paramStr = params.map((param: string) => {
            const nameMatch = param.match(/ac:name="([^"]*)"/);
            const valueMatch = param.match(/<ac:parameter[^>]*>([\s\S]*?)<\/ac:parameter>/);
            return nameMatch && valueMatch ? `${nameMatch[1]}: ${valueMatch[1]}` : '';
          }).filter(Boolean).join(', ');
          
          return `[Confluence Macro: ${macroName}${paramStr ? ` (${paramStr})` : ''}]\n\n`;
      })

      // Handle Confluence placeholders
      .replace(/<ac:placeholder[^>]*>([\s\S]*?)<\/ac:placeholder>/g, '_$1_')

      // Handle Confluence rich text
      .replace(/<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/g, '$1')

      // Remove any remaining Confluence-specific tags
      .replace(/<\/?ac:[^>]*>/g, '')

      // Handle styled spans
      .replace(/<span[^>]*style="color:[^"]*"[^>]*>([\s\S]*?)<\/span>/g, '$1')
      .replace(/<span[^>]*>([\s\S]*?)<\/span>/g, '$1')

      // Basic HTML-like to Markdown conversion
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
      .replace(/\n{3,}/g, '\n\n')      // Remove extra newlines
      .replace(/&quot;/g, '"')         // Convert HTML entities
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\n\s+\n/g, '\n\n')     // Remove lines with only whitespace
      .replace(/([^\n])\n([^\n])/g, '$1 $2')  // Join lines unless there's a blank line
      .replace(/<[^>]+>/g, '')         // Remove any remaining HTML tags
      .trim();
    
    return markdown;
  } catch (error) {
    console.error('Error converting content:', error);
    throw new Error('Failed to convert content to markdown');
  }
}
