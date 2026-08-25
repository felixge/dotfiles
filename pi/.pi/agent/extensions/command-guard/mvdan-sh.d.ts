declare module "mvdan-sh" {
  interface Syntax {
    NewParser(...options: unknown[]): { Parse(source: string, name: string): any };
    NodeType(node: any): string;
  }

  const sh: { syntax: Syntax };
  export = sh;
}
