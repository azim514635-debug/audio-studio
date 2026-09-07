import time 
print("Welcome Enter 1 to start SPAM , ENTER 2 FOR TEXT REPEAT")
a = input("-->")
if a == "1":
 b = "#" 
 increasing = True
 indent = 0
 while True:
  print(" "*indent+b) 
  time.sleep(0.00299)
  if increasing:
     indent += 1
     if  indent == 75:
       increasing = False
  else:
    indent -=1
    if indent == 0:
       increasing = True
  
if a == "2":
  x = input("ENTER TEXT TO REPEAT: ")
  Y = int(input("ENTER NO OF REPEAT"))
  increasing = True
  indent = 0
  z = 0
  while z <= Y:
    print(" " * indent + x)
    z += 1
    time.sleep(0.5)
    if increasing:
       indent += 1
       if indent == 75:
         increasing = False
    else:
     indent -= 1
     if indent == 0:
      increasing = True
       
  