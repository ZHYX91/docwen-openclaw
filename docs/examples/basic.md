用户：帮我把这个 Word 转成 Markdown，并把图片也提取出来

助手：
1) 先检查文件类型  
调用：docwen_inspect(file="C:\\path\\to\\report.docx")

2) 执行转换（提取图片，不启用 OCR）  
调用：docwen_convert(files=["C:\\path\\to\\report.docx"], to="md", extract_img=true, ocr=false)

3) 告知输出文件路径（从返回 JSON 的 data.output_file 获取）

